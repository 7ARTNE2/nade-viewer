use serde_json::Value;

const S: f64 = 10.0;
const E: f64 = 20.0;
fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k)?.as_f64()
}
fn pos(v: &Value, p: &str) -> Option<[f64; 3]> {
    Some([
        num(v, &format!("{p}_pos_x"))?,
        num(v, &format!("{p}_pos_y"))?,
        num(v, &format!("{p}_pos_z"))?,
    ])
}
fn d(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
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
fn fit(a: &Value, b: &Value) -> bool {
    key(a) == key(b)
        && match (
            pos(a, "start"),
            pos(b, "start"),
            pos(a, "explode"),
            pos(b, "explode"),
        ) {
            (Some(a), Some(b), Some(c), Some(end)) => d(a, b) <= S && d(c, end) <= E,
            _ => false,
        }
}
pub(crate) fn deduplicate(items: Vec<Value>) -> Vec<Value> {
    let mut clusters: Vec<Vec<Value>> = Vec::new();
    for item in items {
        let mut target = None;
        let mut score = f64::INFINITY;
        for (i, c) in clusters.iter().enumerate() {
            if c.iter().all(|x| fit(x, &item)) {
                let r = &c[0];
                let q = d(pos(r, "start").unwrap(), pos(&item, "start").unwrap())
                    + d(pos(r, "explode").unwrap(), pos(&item, "explode").unwrap());
                if q < score {
                    score = q;
                    target = Some(i)
                }
            }
        }
        if let Some(i) = target {
            clusters[i].push(item)
        } else {
            clusters.push(vec![item])
        }
    }
    clusters
        .into_iter()
        .map(|c| {
            let mut r = c[0].clone();
            let best = c.iter().max_by_key(|v| usage(v)).unwrap();
            if let (Some(o), Some(n)) = (r.as_object_mut(), best.as_object()) {
                for (k, v) in n {
                    if !o.contains_key(k) {
                        o.insert(k.clone(), v.clone());
                    }
                }
            }
            let total: i64 = c.iter().map(usage).sum();
            r.as_object_mut()
                .unwrap()
                .insert("usage_count".into(), total.into());
            let mut names = Vec::new();
            for v in &c {
                for k in ["thrower", "thrower_steamid64"] {
                    if let Some(s) = v.get(k).and_then(Value::as_str) {
                        if !names.contains(&s.to_string()) {
                            names.push(s.to_string())
                        }
                    }
                }
            }
            if !names.is_empty() {
                r.as_object_mut()
                    .unwrap()
                    .insert("usage_throwers".into(), serde_json::json!(names));
            }
            r
        })
        .collect()
}
