use crate::{plugin, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;
const FORMAT: &str = "nadeviewer_replay";

fn database(app: &AppHandle) -> Result<Connection> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open(&dir.join("replays.sqlite"))
}
fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS matches(
            id INTEGER PRIMARY KEY, hash TEXT NOT NULL, version INTEGER NOT NULL,
            metadata TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
            round_number INTEGER NOT NULL DEFAULT 1, tick REAL,
            UNIQUE(hash,version));
        CREATE TABLE IF NOT EXISTS rounds(
            match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            number INTEGER NOT NULL, summary TEXT NOT NULL, data BLOB NOT NULL,
            PRIMARY KEY(match_id,number));",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}
fn encode(value: &Value) -> Result<Vec<u8>> {
    zstd::stream::encode_all(
        serde_json::to_vec(value)
            .map_err(|e| e.to_string())?
            .as_slice(),
        3,
    )
    .map_err(|e| e.to_string())
}
fn decode(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice(&zstd::stream::decode_all(bytes).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_replay_capability(app: AppHandle) -> bool {
    supports_replay(&plugin::exe(&app))
}
fn supports_replay(path: &std::path::Path) -> bool {
    plugin::hide_console(&mut Command::new(path))
        .arg("--plugin-info")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        .is_some_and(|v| {
            v["capabilities"]
                .as_array()
                .is_some_and(|a| a.iter().any(|c| c == "replay_v1"))
        })
}

#[derive(Serialize)]
pub(crate) struct ReplayEntry {
    id: i64,
    metadata: Value,
    size: i64,
    round_number: i64,
    tick: Option<f64>,
}
#[tauri::command]
pub(crate) fn list_replays(app: AppHandle) -> Result<Vec<ReplayEntry>> {
    let conn = database(&app)?;
    let mut stmt = conn
        .prepare("SELECT id,metadata,size,round_number,tick FROM matches ORDER BY id DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<f64>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        let (id, metadata, size, round_number, tick) = r.map_err(|e| e.to_string())?;
        Ok(ReplayEntry {
            id,
            metadata: serde_json::from_str(&metadata).map_err(|e| e.to_string())?,
            size,
            round_number,
            tick,
        })
    })
    .collect()
}
#[tauri::command]
pub(crate) fn get_replay(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<Value> {
    let conn = database(&app)?;
    let (raw, round, tick): (String, i64, Option<f64>) = conn
        .query_row(
            "SELECT metadata,round_number,tick FROM matches WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let metadata: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT summary FROM rounds WHERE match_id=?1 ORDER BY number")
        .map_err(|e| e.to_string())?;
    let summaries: Vec<Value> = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect::<Result<_>>()?;
    let map = metadata["map"].as_str().unwrap_or("");
    let assets = crate::open_conn(&state).map_err(|e| e.to_string())?;
    let summary =
        crate::map_asset_summary(&assets, &state.radars, map).map_err(|e| e.to_string())?;
    let radar = state
        .radars
        .get(&crate::map_name_to_key(map))
        .map(|r| json!({"pos_x":r.pos_x,"pos_y":r.pos_y,"scale":r.scale,"split_z":r.split_z}));
    Ok(
        json!({"id":id,"metadata":metadata,"rounds":summaries,"map":summary,"radar":radar,"round_number":round,"tick":tick}),
    )
}
#[tauri::command]
pub(crate) fn get_replay_round(app: AppHandle, id: i64, number: i64) -> Result<Value> {
    let conn = database(&app)?;
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT data FROM rounds WHERE match_id=?1 AND number=?2",
            params![id, number],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    decode(&bytes)
}
#[tauri::command]
pub(crate) fn save_replay_position(app: AppHandle, id: i64, number: i64, tick: f64) -> Result<()> {
    if !tick.is_finite() {
        return Err("Invalid replay tick".into());
    }
    database(&app)?
        .execute(
            "UPDATE matches SET round_number=?2,tick=?3 WHERE id=?1",
            params![id, number, tick],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub(crate) fn delete_replay(app: AppHandle, id: i64) -> Result<()> {
    database(&app)?
        .execute("DELETE FROM matches WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn start_replay(app: AppHandle, path: String) -> Result<()> {
    if !std::path::Path::new(&path).is_file() {
        return Err("Demo file does not exist".into());
    }
    if !supports_replay(&plugin::exe(&app)) {
        return Err("Install Nade Parser 0.3.0 or newer with replay support".into());
    }
    let status = plugin::state(&app);
    let control = plugin::control(&app);
    {
        let mut status = status.lock().unwrap();
        if status.running {
            return Err("A parser job is already running".into());
        }
        control.reset();
        status.start("replay");
    }
    let worker = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("replay-parser".into())
        .spawn(move || {
            let result = run(&worker, &path);
            plugin::state(&worker)
                .lock()
                .unwrap()
                .finish(result.map(|id| Some(PathBuf::from(format!("replay:{id}")))));
        })
    {
        status.lock().unwrap().finish(Err(e.to_string()));
        return Err(e.to_string());
    }
    Ok(())
}

fn run(app: &AppHandle, path: &str) -> Result<i64> {
    let control = plugin::control(app);
    let mut child = plugin::hide_console(&mut Command::new(plugin::exe(app)))
        .args(["--replay", "--demo", path, "--output", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.id();
    control.register(pid);
    if control.is_cancelled() {
        control.cancel()
    }
    let stderr = child.stderr.take().ok_or("Missing parser stderr")?;
    // Drain stderr concurrently; retain only a bounded diagnostic tail.
    let diagnostic = std::thread::spawn(move || {
        let mut tail = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut reader = stderr;
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buffer[..n]);
            if tail.len() > 32768 {
                tail.drain(..tail.len() - 32768);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let stdout = child.stdout.take().ok_or("Missing parser stdout")?;
    // Replay output is a large NDJSON stream. A larger BufReader reduces the
    // number of pipe reads and JSON line boundary checks during ingestion.
    let stdout = BufReader::with_capacity(1 << 20, stdout);
    let result = (|| {
        let mut conn = database(app)?;
        ingest(
            &mut conn,
            BufReader::new(stdout),
            || control.is_cancelled(),
            || {
                plugin::state(app).lock().unwrap().completed += 1;
            },
            || {
                if child.wait().map_err(|e| e.to_string())?.success() {
                    Ok(())
                } else {
                    Err("Replay parser failed".into())
                }
            },
        )
    })();
    let _ = child.kill();
    let _ = child.wait();
    control.unregister(pid);
    let tail = diagnostic.join().unwrap_or_default();
    result.map_err(|e| {
        if tail.trim().is_empty() {
            e
        } else {
            format!("{e}: {}", tail.trim())
        }
    })
}

fn ingest(
    conn: &mut Connection,
    reader: impl BufRead,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(),
    mut finish: impl FnMut() -> Result<()>,
) -> Result<i64> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut match_id = None;
    let mut completed = false;
    let mut late: Vec<Value> = Vec::new();
    let mut size = 0i64;
    for line in reader.lines() {
        if cancelled() {
            return Err("Parsing cancelled".into());
        }
        let value: Value =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        match value["type"].as_str().unwrap_or("") {
            "metadata" => {
                if value["format"] != FORMAT || value["version"] != 1 {
                    return Err("Unsupported replay format".into());
                }
                let hash = value["file_sha256"].as_str().ok_or("Missing demo hash")?;
                if let Some(id) = tx
                    .query_row(
                        "SELECT id FROM matches WHERE hash=?1 AND version=1",
                        [hash],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                {
                    return Ok(id);
                }
                tx.execute(
                    "INSERT INTO matches(hash,version,metadata)VALUES(?1,1,?2)",
                    params![hash, value.to_string()],
                )
                .map_err(|e| e.to_string())?;
                match_id = Some(tx.last_insert_rowid());
            }
            "round" => {
                let id = match_id.ok_or("Round before metadata")?;
                let number = value["round_number"]
                    .as_i64()
                    .ok_or("Missing round number")?;
                let mut round = value;
                round["grenades"] = json!([]);
                if round["events"].is_null() {
                    round["events"] = json!([]);
                }
                if round["frames"].is_null() {
                    round["frames"] = json!([]);
                }
                let bytes = encode(&round)?;
                size += bytes.len() as i64;
                tx.execute(
                    "INSERT INTO rounds(match_id,number,summary,data)VALUES(?1,?2,?3,?4)",
                    params![id, number, round["round"].to_string(), bytes],
                )
                .map_err(|e| e.to_string())?;
                progress();
            }
            "grenade" => late.push(value),
            "complete" => {
                let id = match_id.ok_or("Completion before metadata")?;
                if completed {
                    return Err("Duplicate replay completion".into());
                }
                tx.execute(
                    "UPDATE matches SET metadata=?2 WHERE id=?1",
                    params![id, value.to_string()],
                )
                .map_err(|e| e.to_string())?;
                completed = true;
            }
            _ => return Err("Unknown replay record".into()),
        }
    }
    finish()?;
    if cancelled() {
        return Err("Parsing cancelled".into());
    }
    if !completed {
        return Err("Replay parser did not complete".into());
    }
    let id = match_id.ok_or("Empty replay")?;
    // Late finalization can refer to a round already written to disk.
    let mut grouped = std::collections::BTreeMap::<i64, Vec<Value>>::new();
    for record in late {
        grouped
            .entry(
                record["round_number"]
                    .as_i64()
                    .ok_or("Missing grenade round")?,
            )
            .or_default()
            .push(record);
    }
    for (number, records) in grouped {
        let old: Vec<u8> = tx
            .query_row(
                "SELECT data FROM rounds WHERE match_id=?1 AND number=?2",
                params![id, number],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut round = decode(&old)?;
        for record in records {
            round["grenades"]
                .as_array_mut()
                .ok_or("Missing grenades")?
                .push(record["grenade"].clone());
            if let Some(events) = record["events"].as_array() {
                round["events"]
                    .as_array_mut()
                    .ok_or("Missing events")?
                    .extend(events.iter().cloned());
            }
        }
        round["grenades"]
            .as_array_mut()
            .ok_or("Missing grenades")?
            .sort_by_key(|g| g["release_tick"].as_i64().unwrap_or(0));
        round["events"]
            .as_array_mut()
            .ok_or("Missing events")?
            .sort_by_key(|e| e["tick"].as_i64().unwrap_or(0));
        let bytes = encode(&round)?;
        size += bytes.len() as i64 - old.len() as i64;
        tx.execute(
            "UPDATE rounds SET data=?3 WHERE match_id=?1 AND number=?2",
            params![id, number, bytes],
        )
        .map_err(|e| e.to_string())?;
    }
    let first: i64 = tx
        .query_row(
            "SELECT COALESCE(MIN(CASE WHEN number>0 THEN number END),MIN(number)) FROM rounds WHERE match_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE matches SET size=?2,round_number=?3 WHERE id=?1",
        params![id, size, first],
    )
    .map_err(|e| e.to_string())?;
    if cancelled() {
        return Err("Parsing cancelled".into());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_round_preserves_ids() {
        let value = json!({"players":[{"steamid64":"76561198012345678"}],"grenades":[]});
        assert_eq!(decode(&encode(&value).unwrap()).unwrap(), value);
    }

    #[test]
    fn stream_is_atomic_and_deduplicates_and_cascades() {
        let mut conn = open(std::path::Path::new(":memory:")).unwrap();
        let source = concat!(
            "{\"type\":\"metadata\",\"format\":\"nadeviewer_replay\",\"version\":1,\"file_sha256\":\"test\"}\n",
            "{\"type\":\"grenade\",\"round_number\":0,\"grenade\":{\"id\":\"99999999999999999\",\"release_tick\":10},\"events\":[]}\n",
            "{\"type\":\"round\",\"round_number\":0,\"round\":{\"number\":0},\"frames\":[],\"events\":[]}\n",
            "{\"type\":\"complete\",\"map\":\"Mirage\"}\n"
        );
        assert!(ingest(
            &mut conn,
            source.as_bytes(),
            || false,
            || {},
            || Err("failed".into())
        )
        .is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM matches", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(ingest(&mut conn, source.as_bytes(), || true, || {}, || Ok(())).is_err());
        let id = ingest(&mut conn, source.as_bytes(), || false, || {}, || Ok(())).unwrap();
        let bytes: Vec<u8> = conn
            .query_row("SELECT data FROM rounds WHERE match_id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            decode(&bytes).unwrap()["grenades"][0]["id"],
            "99999999999999999"
        );
        assert_eq!(
            ingest(
                &mut conn,
                source.as_bytes(),
                || false,
                || {},
                || panic!("cached match should not wait")
            )
            .unwrap(),
            id
        );
        conn.execute("DELETE FROM matches WHERE id=?1", [id])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rounds", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn local_demo_stream_round_trip() {
        let Ok(path) = std::env::var("NADE_REPLAY_STREAM") else {
            return;
        };
        let mut conn = open(std::path::Path::new(":memory:")).unwrap();
        let file = fs::File::open(path).unwrap();
        let id = ingest(&mut conn, BufReader::new(file), || false, || {}, || Ok(())).unwrap();
        let (rounds,size):(i64,i64)=conn.query_row("SELECT (SELECT COUNT(*) FROM rounds WHERE match_id=?1),size FROM matches WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert!(rounds > 0 && size > 0);
        eprintln!("replay storage: {rounds} rounds, {size} bytes");
    }
}
