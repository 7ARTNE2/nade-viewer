use serde_json::Value;
use std::collections::{HashMap, HashSet};

const S: f64 = 10.0;
const E: f64 = 20.0;
const S_SQUARED: f64 = S * S;
const E_SQUARED: f64 = E * E;

type Position = [f64; 3];

#[derive(Clone, Copy)]
struct Positions {
    start: Position,
    explode: Position,
}

struct Cluster {
    items: Vec<Value>,
    positions: Vec<Positions>,
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k)?.as_f64()
}

fn pos(v: &Value, p: &str) -> Option<Position> {
    Some([
        num(v, &format!("{p}_pos_x"))?,
        num(v, &format!("{p}_pos_y"))?,
        num(v, &format!("{p}_pos_z"))?,
    ])
}

fn positions(v: &Value) -> Option<Positions> {
    Some(Positions {
        start: pos(v, "start")?,
        explode: pos(v, "explode")?,
    })
}

fn squared_distance(a: Position, b: Position) -> f64 {
    let x = a[0] - b[0];
    let y = a[1] - b[1];
    let z = a[2] - b[2];
    x * x + y * y + z * z
}

fn usage(v: &Value) -> i64 {
    v.get("usage_count")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(1)
}

fn key(v: &Value) -> String {
    ["map", "side", "grenade_type", "throw_keys"]
        .iter()
        .map(|k| {
            v.get(*k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_lowercase()
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn fits_cluster(cluster: &Cluster, candidate: Positions) -> bool {
    cluster.positions.len() == cluster.items.len()
        && cluster.positions.iter().all(|existing| {
            squared_distance(existing.start, candidate.start) <= S_SQUARED
                && squared_distance(existing.explode, candidate.explode) <= E_SQUARED
        })
}

fn cluster_score(cluster: &Cluster, candidate: Positions) -> f64 {
    let representative = cluster.positions[0];
    squared_distance(representative.start, candidate.start).sqrt()
        + squared_distance(representative.explode, candidate.explode).sqrt()
}

/// Collapses nearby throws with the same map, side, grenade type and throw keys.
///
/// Candidate clusters are indexed by their normalized signature, so comparisons
/// only happen inside matching groups. Spatial checks stay deliberately strict:
/// a new item must be within the configured tolerance of every cluster member.
pub(crate) fn deduplicate(items: Vec<Value>) -> Vec<Value> {
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut clusters_by_key: HashMap<String, Vec<usize>> = HashMap::new();

    for item in items {
        let item_key = key(&item);
        let item_positions = positions(&item);
        let mut target = None;
        let mut score = f64::INFINITY;

        if let Some(candidate) = item_positions {
            if let Some(indices) = clusters_by_key.get(&item_key) {
                for &index in indices {
                    let cluster = &clusters[index];
                    if fits_cluster(cluster, candidate) {
                        let candidate_score = cluster_score(cluster, candidate);
                        if candidate_score < score {
                            score = candidate_score;
                            target = Some(index);
                        }
                    }
                }
            }
        }

        if let Some(index) = target {
            let cluster = &mut clusters[index];
            cluster.items.push(item);
            cluster
                .positions
                .push(item_positions.expect("matched item has positions"));
            continue;
        }

        let index = clusters.len();
        let mut cluster = Cluster {
            items: Vec::with_capacity(1),
            positions: Vec::with_capacity(1),
        };
        cluster.items.push(item);
        if let Some(candidate) = item_positions {
            cluster.positions.push(candidate);
        }
        clusters.push(cluster);
        clusters_by_key.entry(item_key).or_default().push(index);
    }

    clusters.into_iter().map(merge_cluster).collect()
}

fn merge_cluster(cluster: Cluster) -> Value {
    let mut representative = cluster.items[0].clone();
    let best = cluster
        .items
        .iter()
        .max_by_key(|value| usage(value))
        .unwrap();
    if let (Some(output), Some(best)) = (representative.as_object_mut(), best.as_object()) {
        for (key, value) in best {
            if !output.contains_key(key) {
                output.insert(key.clone(), value.clone());
            }
        }
    }

    let total: i64 = cluster.items.iter().map(usage).sum();
    if let Some(output) = representative.as_object_mut() {
        output.insert("usage_count".into(), total.into());
    }

    let mut names = Vec::new();
    let mut seen_names = HashSet::new();
    for item in &cluster.items {
        for key in ["thrower", "thrower_steamid64"] {
            if let Some(name) = item.get(key).and_then(Value::as_str) {
                if seen_names.insert(name.to_owned()) {
                    names.push(name.to_owned());
                }
            }
        }
    }
    if !names.is_empty() {
        if let Some(output) = representative.as_object_mut() {
            output.insert("usage_throwers".into(), serde_json::json!(names));
        }
    }

    representative
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn grenade(map: &str, start: Position, explode: Position) -> Value {
        json!({
            "map": map,
            "side": "T",
            "grenade_type": "smoke",
            "throw_keys": "LMB",
            "start_pos_x": start[0],
            "start_pos_y": start[1],
            "start_pos_z": start[2],
            "explode_pos_x": explode[0],
            "explode_pos_y": explode[1],
            "explode_pos_z": explode[2],
        })
    }

    #[test]
    fn merges_matching_nearby_throws() {
        let mut first = grenade("de_mirage", [0.0, 0.0, 0.0], [100.0, 0.0, 0.0]);
        first["usage_count"] = 2.into();
        first["thrower"] = "Alice".into();
        let mut second = grenade("de_mirage", [6.0, 0.0, 0.0], [115.0, 0.0, 0.0]);
        second["usage_count"] = 3.into();
        second["thrower"] = "Bob".into();

        let result = deduplicate(vec![first, second]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["usage_count"], 5);
        assert_eq!(result[0]["usage_throwers"], json!(["Alice", "Bob"]));
    }

    #[test]
    fn preserves_non_object_values_without_panicking() {
        let input = json!("invalid grenade");
        assert_eq!(deduplicate(vec![input.clone()]), vec![input]);
    }

    #[test]
    fn does_not_merge_different_signatures_or_missing_positions() {
        let first = grenade("de_mirage", [0.0, 0.0, 0.0], [100.0, 0.0, 0.0]);
        let different_map = grenade("de_inferno", [0.0, 0.0, 0.0], [100.0, 0.0, 0.0]);
        let missing_positions = json!({
            "map": "de_mirage",
            "side": "T",
            "grenade_type": "smoke",
            "throw_keys": "LMB",
        });

        assert_eq!(
            deduplicate(vec![first, different_map, missing_positions]).len(),
            3
        );
    }
}
