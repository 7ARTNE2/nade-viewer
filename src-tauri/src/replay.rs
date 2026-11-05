use crate::{plugin, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
            PRIMARY KEY(match_id,number));
        CREATE TABLE IF NOT EXISTS replay_notes(
            match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            id TEXT NOT NULL, round_number INTEGER NOT NULL, tick REAL NOT NULL,
            lower_radar INTEGER NOT NULL, text TEXT NOT NULL, strokes TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(match_id,id),
            FOREIGN KEY(match_id,round_number) REFERENCES rounds(match_id,number) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS replay_notes_updated ON replay_notes(updated_at DESC);",
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ReplayStroke {
    tool: String,
    color: String,
    points: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ReplayNote {
    id: String,
    round: i64,
    tick: f64,
    lower: bool,
    text: String,
    strokes: Vec<ReplayStroke>,
}

#[derive(Debug, Serialize)]
pub(crate) struct StoredReplayNote {
    replay_id: i64,
    note: ReplayNote,
    round_summary: Value,
    updated_at: i64,
}

fn read_notes(conn: &Connection, replay_id: Option<i64>) -> Result<Vec<StoredReplayNote>> {
    let mut stmt = conn.prepare(
        "SELECT n.match_id,n.id,n.round_number,n.tick,n.lower_radar,n.text,n.strokes,r.summary,n.updated_at
         FROM replay_notes n JOIN rounds r ON r.match_id=n.match_id AND r.number=n.round_number
         WHERE (?1 IS NULL OR n.match_id=?1) ORDER BY n.updated_at DESC,n.match_id,n.round_number,n.tick,n.id",
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([replay_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (replay_id, id, round, tick, lower, text, strokes, summary, updated_at) =
            row.map_err(|e| e.to_string())?;
        Ok(StoredReplayNote {
            replay_id,
            note: ReplayNote {
                id,
                round,
                tick,
                lower,
                text,
                strokes: serde_json::from_str(&strokes).map_err(|e| e.to_string())?,
            },
            round_summary: serde_json::from_str(&summary).map_err(|e| e.to_string())?,
            updated_at,
        })
    })
    .collect()
}

fn write_notes(
    conn: &mut Connection,
    replay_id: i64,
    notes: &[ReplayNote],
) -> Result<Vec<StoredReplayNote>> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM matches WHERE id=?1)",
            [replay_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Replay not found".into());
    }
    let mut ids = std::collections::HashSet::new();
    for note in notes {
        if note.id.is_empty()
            || !ids.insert(&note.id)
            || !note.tick.is_finite()
            || note.tick < 0.0
            || note.round < 0
        {
            return Err("Invalid replay note".into());
        }
        for stroke in &note.strokes {
            if !["pen", "arrow", "circle"].contains(&stroke.tool.as_str())
                || stroke.color.len() != 7
                || !stroke.color.starts_with('#')
                || !stroke.color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                || stroke.points.is_empty()
                || stroke.points.iter().flatten().any(|v| !v.is_finite())
            {
                return Err("Invalid replay drawing".into());
            }
        }
        tx.execute(
            "INSERT INTO replay_notes(match_id,id,round_number,tick,lower_radar,text,strokes,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
             ON CONFLICT(match_id,id) DO UPDATE SET round_number=excluded.round_number,tick=excluded.tick,
             lower_radar=excluded.lower_radar,text=excluded.text,strokes=excluded.strokes,updated_at=excluded.updated_at
             WHERE round_number!=excluded.round_number OR tick!=excluded.tick OR lower_radar!=excluded.lower_radar
             OR text!=excluded.text OR strokes!=excluded.strokes",
            params![replay_id,note.id,note.round,note.tick,note.lower,note.text,serde_json::to_string(&note.strokes).map_err(|e| e.to_string())?],
        ).map_err(|e| e.to_string())?;
    }
    // Replace only this replay's collection, keeping unchanged notes' edit times.
    let old = read_notes(&tx, Some(replay_id))?;
    for stored in old {
        if !ids.contains(&stored.note.id) {
            tx.execute(
                "DELETE FROM replay_notes WHERE match_id=?1 AND id=?2",
                params![replay_id, stored.note.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let result = read_notes(&tx, Some(replay_id))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn list_replay_notes(app: AppHandle) -> Result<Vec<StoredReplayNote>> {
    read_notes(&database(&app)?, None)
}

#[tauri::command]
pub(crate) fn save_replay_notes(
    app: AppHandle,
    replay_id: i64,
    notes: Vec<ReplayNote>,
) -> Result<Vec<StoredReplayNote>> {
    write_notes(&mut database(&app)?, replay_id, &notes)
}

#[tauri::command]
pub(crate) fn get_replay_capability(app: AppHandle) -> bool {
    [plugin::ParserProfile::V5, plugin::ParserProfile::V6]
        .into_iter()
        .any(|profile| supports_replay(&plugin::parser_exe(&app, profile)))
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
    score_t: i64,
    score_ct: i64,
    winner_side: String,
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
    let records: Vec<_> = rows
        .map(|r| r.map_err(|e| e.to_string()))
        .collect::<Result<_>>()?;
    records
        .into_iter()
        .map(|(id, metadata, size, round_number, tick)| {
            let metadata_value: Value =
                serde_json::from_str(&metadata).map_err(|e| e.to_string())?;
            // The last round summary contains the score at its start. Add
            // that round's winner to get the final score. Unlike a cumulative
            // winner count this remains valid when T/CT sides switch at half.
            let mut final_score_t = 0_i64;
            let mut final_score_ct = 0_i64;
            let final_summary_raw: Option<String> = conn
                .query_row(
                    "SELECT summary FROM rounds WHERE match_id=?1 AND number>0 ORDER BY number DESC LIMIT 1",
                    [id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(summary_raw) = final_summary_raw {
                let summary: Value =
                    serde_json::from_str(&summary_raw).map_err(|e| e.to_string())?;
                final_score_t = summary["score_t"].as_i64().unwrap_or(0);
                final_score_ct = summary["score_ct"].as_i64().unwrap_or(0);
                match summary["winner_side"].as_str().unwrap_or_default() {
                    "T" => final_score_t += 1,
                    "CT" => final_score_ct += 1,
                    _ => {}
                }
            }
            let score_t = final_score_t;
            let score_ct = final_score_ct;
            let winner_side = if score_t > score_ct {
                "T".to_string()
            } else if score_ct > score_t {
                "CT".to_string()
            } else {
                String::new()
            };
            Ok(ReplayEntry {
                id,
                metadata: metadata_value,
                size,
                round_number,
                tick,
                score_t,
                score_ct,
                winner_side,
            })
        })
        .collect()
}
#[tauri::command]
pub(crate) fn get_replay(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<Option<Value>> {
    let conn = database(&app)?;
    let Some((raw, round, tick)) = read_replay_metadata(&conn, id)? else {
        return Ok(None);
    };
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
    Ok(Some(
        json!({"id":id,"metadata":metadata,"rounds":summaries,"map":summary,"radar":radar,"round_number":round,"tick":tick}),
    ))
}

fn read_replay_metadata(conn: &Connection, id: i64) -> Result<Option<(String, i64, Option<f64>)>> {
    conn.query_row(
        "SELECT metadata,round_number,tick FROM matches WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(|e| format!("stage: load replay metadata\nreplay_id: {id}\ncause: {e}"))
}
#[tauri::command]
pub(crate) async fn get_replay_round(app: AppHandle, id: i64, number: i64) -> Result<Value> {
    // Prefetch runs during playback; JSON/zstd work must not occupy Tauri's
    // window thread, even when the JavaScript caller awaits the command.
    tauri::async_runtime::spawn_blocking(move || read_round(&database(&app)?, id, number))
        .await
        .map_err(|e| e.to_string())?
}

fn read_round(conn: &Connection, id: i64, number: i64) -> Result<Value> {
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT data FROM rounds WHERE match_id=?1 AND number=?2",
            params![id, number],
            |r| r.get(0),
        )
        .map_err(|e| {
            format!("stage: read stored round\nreplay_id: {id}\nround: {number}\ncause: {e}")
        })?;
    decode(&bytes).map_err(|e| {
        format!("stage: decode stored round\nreplay_id: {id}\nround: {number}\ncause: {e}")
    })
}

/// Return only the data needed by the round rail tooltip. Full rounds contain
/// thousands of sampled frames and projectile trajectories; decoding all of
/// that on every hover makes the preview feel unresponsive on large demos.
#[tauri::command]
pub(crate) async fn get_replay_round_preview(
    app: AppHandle,
    id: i64,
    number: i64,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(round_preview(
            read_round(&database(&app)?, id, number)?,
            number,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn round_preview(mut round: Value, number: i64) -> Value {
    // Player identity and team are stable through a round. The first sampled
    // frame is enough for the tooltip; avoid walking every sampled frame.
    let players = round["frames"]
        .as_array()
        .and_then(|frames| frames.first())
        .and_then(|frame| frame["players"].as_array())
        .cloned()
        .unwrap_or_default();
    let preview_frame = json!({
        "tick": round["round"]["start_tick"].as_i64().unwrap_or_default(),
        "round_number": number,
        "players": players,
        "projectiles": [],
        "infernos": [],
        "bomb": null
    });
    round["frames"] = json!([preview_frame]);
    round["grenades"] = json!([]);
    round
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
pub(crate) fn start_replay(app: AppHandle, path: String, profile: String) -> Result<()> {
    if !std::path::Path::new(&path).is_file() {
        return Err("Demo file does not exist".into());
    }
    let profile = plugin::ParserProfile::from_id(&profile)?;
    let executable = plugin::parser_exe(&app, profile);
    if !supports_replay(&executable) {
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
            let result = run(&worker, &path, profile);
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

fn run(app: &AppHandle, path: &str, profile: plugin::ParserProfile) -> Result<i64> {
    run_parser(app, path, profile).map_err(|error| {
        let message = format!(
            "Replay parsing failed\ndemo: {path}\nprofile: {}\nparser: {}\n{error}",
            profile.id(),
            plugin::parser_exe(app, profile).display()
        );
        eprintln!("{message}");
        message
    })
}

fn run_parser(app: &AppHandle, path: &str, profile: plugin::ParserProfile) -> Result<i64> {
    let control = plugin::control(app);
    let mut child = plugin::hide_console(&mut Command::new(plugin::parser_exe(app, profile)))
        .args(["--replay", "--demo", path, "--output", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("stage: launch parser\ncause: {e}"))?;
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
        let mut conn =
            database(app).map_err(|e| format!("stage: open replay database\ncause: {e}"))?;
        ingest(
            &mut conn,
            BufReader::new(stdout),
            profile.id(),
            || control.is_cancelled(),
            || {
                plugin::state(app).lock().unwrap().completed += 1;
            },
            || {
                let status = child.wait().map_err(|e| format!("Wait for parser: {e}"))?;
                if status.success() {
                    Ok(())
                } else {
                    Err(format!("Replay parser exited with {status}"))
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
            format!("{e}\nparser stderr (last 32 KiB):\n{}", tail.trim())
        }
    })
}

fn ingest(
    conn: &mut Connection,
    reader: impl BufRead,
    profile: &str,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(),
    mut finish: impl FnMut() -> Result<()>,
) -> Result<i64> {
    let mut stage = String::from("begin import transaction");
    let mut match_id = None;
    let mut line_number = 0;
    let mut written_rounds = std::collections::BTreeSet::new();
    let result: Result<i64> = (|| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut completed = false;
        let mut late: Vec<Value> = Vec::new();
        let mut size = 0i64;
        for line in reader.lines() {
            line_number += 1;
            stage = String::from("read NDJSON record");
            if cancelled() {
                return Err("Parsing cancelled".into());
            }
            let value: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            stage = format!(
                "ingest {} record (round={})",
                value["type"], value["round_number"]
            );
            match value["type"].as_str().unwrap_or("") {
                "metadata" => {
                    if value["format"] != FORMAT || value["version"] != 1 {
                        return Err("Unsupported replay format".into());
                    }
                    let hash = value["file_sha256"].as_str().ok_or("Missing demo hash")?;
                    if let Some(id) = tx
                    .query_row(
                        "SELECT id FROM matches WHERE hash=?1 AND version=1 AND (json_extract(metadata,'$.parser_profile')=?2 OR (json_extract(metadata,'$.parser_profile') IS NULL AND ?2='v5'))",
                        params![hash, profile],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                {
                    return Ok(id);
                }
                    let mut metadata = value.clone();
                    metadata["parser_profile"] = Value::String(profile.to_owned());
                    tx.execute(
                        "INSERT INTO matches(hash,version,metadata)VALUES(?1,1,?2)",
                        params![hash, metadata.to_string()],
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
                    written_rounds.insert(number);
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
        stage = String::from("wait for parser completion");
        finish()?;
        if cancelled() {
            return Err("Parsing cancelled".into());
        }
        if !completed {
            return Err("Replay parser did not complete".into());
        }
        let id = match_id.ok_or("Empty replay")?;
        stage = String::from("group late grenades");
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
            stage = format!(
            "load round for late grenades (round={number}, grenades={}, first_id={}, release_tick={})",
            records.len(), records[0]["grenade"]["id"], records[0]["grenade"]["release_tick"]
        );
            let old: Vec<u8> = tx
                .query_row(
                    "SELECT data FROM rounds WHERE match_id=?1 AND number=?2",
                    params![id, number],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            stage = format!("decode round for late grenades (round={number})");
            let mut round = decode(&old)?;
            stage = format!("merge late grenades (round={number})");
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
            stage = format!("save round with late grenades (round={number})");
            let bytes = encode(&round)?;
            size += bytes.len() as i64 - old.len() as i64;
            tx.execute(
                "UPDATE rounds SET data=?3 WHERE match_id=?1 AND number=?2",
                params![id, number, bytes],
            )
            .map_err(|e| e.to_string())?;
        }
        stage = String::from("select initial round");
        let first: i64 = tx
        .query_row(
            "SELECT COALESCE(MIN(CASE WHEN number>0 THEN number END),MIN(number)) FROM rounds WHERE match_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
        stage = String::from("save replay position and size");
        tx.execute(
            "UPDATE matches SET size=?2,round_number=?3 WHERE id=?1",
            params![id, size, first],
        )
        .map_err(|e| e.to_string())?;
        if cancelled() {
            return Err("Parsing cancelled".into());
        }
        stage = String::from("commit replay transaction");
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    })();
    result.map_err(|error| {
        format!(
            "stage: {stage}\nprofile: {profile}\nreplay_id: {match_id:?}\nNDJSON line: {line_number}\nwritten rounds: {written_rounds:?}\ncause: {error}"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_persist_validate_atomically_and_cascade() {
        let path = std::env::temp_dir().join(format!(
            "nade-replay-notes-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut conn = open(&path).unwrap();
        for id in [1, 2] {
            conn.execute(
                "INSERT INTO matches(id,hash,version,metadata) VALUES(?1,?1,1,'{}')",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rounds(match_id,number,summary,data) VALUES(?1,1,?2,x'00')",
                params![
                    id,
                    json!({"number":1,"start_tick":100,"freeze_end_tick":200,"end_tick":1000})
                        .to_string()
                ],
            )
            .unwrap();
        }
        let mut note: ReplayNote = serde_json::from_value(json!({"id":"same-note-id","round":1,"tick":350.5,"lower":true,"text":"Занять B","strokes":[{"tool":"arrow","color":"#123abc","points":[[10.25,20.5],[50.0,75.0]]}]})).unwrap();
        let first = write_notes(&mut conn, 1, &[note.clone()]).unwrap();
        let timestamp = first[0].updated_at;
        write_notes(&mut conn, 2, &[note.clone()]).unwrap();
        // Saving another replay with the same note ID must not affect this one.
        note.text = "Вторая запись".into();
        write_notes(&mut conn, 2, &[note.clone()]).unwrap();
        drop(conn);
        let mut conn = open(&path).unwrap();
        let saved = read_notes(&conn, Some(1)).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].note.text, "Занять B");
        assert_eq!(saved[0].note.tick, 350.5);
        assert!(saved[0].note.lower);
        assert_eq!(
            saved[0].note.strokes[0].points,
            vec![[10.25, 20.5], [50.0, 75.0]]
        );
        assert_eq!(saved[0].round_summary["start_tick"], 100);
        assert_eq!(
            write_notes(&mut conn, 1, &[saved[0].note.clone()]).unwrap()[0].updated_at,
            timestamp
        );
        assert_eq!(read_notes(&conn, None).unwrap().len(), 2);
        // A bad second record rolls back even the valid edit preceding it.
        let mut invalid = note.clone();
        invalid.id = "invalid".into();
        invalid.round = 999;
        assert!(write_notes(&mut conn, 1, &[note.clone(), invalid]).is_err());
        assert_eq!(read_notes(&conn, Some(1)).unwrap()[0].note.text, "Занять B");
        note.strokes[0].color = "invalid".into();
        assert!(write_notes(&mut conn, 1, &[note.clone()]).is_err());
        assert!(write_notes(&mut conn, 999, &[]).is_err());
        write_notes(&mut conn, 1, &[]).unwrap();
        assert_eq!(read_notes(&conn, None).unwrap().len(), 1);
        conn.execute("DELETE FROM matches WHERE id=2", []).unwrap();
        assert!(read_notes(&conn, None).unwrap().is_empty());
        drop(conn);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn compressed_round_preserves_ids() {
        let value = json!({"players":[{"steamid64":"76561198012345678"}],"grenades":[]});
        assert_eq!(decode(&encode(&value).unwrap()).unwrap(), value);
    }

    #[test]
    fn round_read_and_preview_keep_events_and_player_identity() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        conn.execute(
            "INSERT INTO matches(id,hash,version,metadata) VALUES(1,'preview',1,'{}')",
            [],
        )
        .unwrap();
        let value = json!({
            "round_number": 13,
            "round": {"number":13,"start_tick":100,"score_t":6,"score_ct":6},
            "frames": [
                {"tick":104,"players":[{"id":"76561198012345678","name":"Player"}],"projectiles":[{"id":"g"}]},
                {"tick":108,"players":[],"projectiles":[]}
            ],
            "events":[{"type":"kill","tick":110,"player_id":"76561198012345678"}],
            "grenades":[{"id":"g"}]
        });
        conn.execute(
            "INSERT INTO rounds(match_id,number,summary,data) VALUES(1,13,?1,?2)",
            params![value["round"].to_string(), encode(&value).unwrap()],
        )
        .unwrap();
        let full = read_round(&conn, 1, 13).unwrap();
        assert_eq!(full, value);
        let preview = round_preview(full, 13);
        assert_eq!(preview["round"], value["round"]);
        assert_eq!(preview["events"], value["events"]);
        assert_eq!(preview["frames"].as_array().unwrap().len(), 1);
        assert_eq!(preview["frames"][0]["tick"], 100);
        assert_eq!(
            preview["frames"][0]["players"],
            value["frames"][0]["players"]
        );
        assert_eq!(preview["frames"][0]["projectiles"], json!([]));
        assert_eq!(preview["grenades"], json!([]));
        assert_eq!(read_round(&conn, 1, 13).unwrap(), value);
        assert!(read_round(&conn, 1, 99).is_err());
        let empty = round_preview(json!({"round":{"start_tick":100}}), 13);
        assert_eq!(empty["frames"][0]["players"], json!([]));
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
            "v5",
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
        assert!(ingest(
            &mut conn,
            source.as_bytes(),
            "v5",
            || true,
            || {},
            || Ok(())
        )
        .is_err());
        let id = ingest(
            &mut conn,
            source.as_bytes(),
            "v5",
            || false,
            || {},
            || Ok(()),
        )
        .unwrap();
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
                "v5",
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
        let reparsed = ingest(
            &mut conn,
            source.as_bytes(),
            "v5",
            || false,
            || {},
            || Ok(()),
        )
        .unwrap();
        assert_eq!(reparsed, id, "SQLite may reuse the deleted replay ID");
        assert!(read_replay_metadata(&conn, reparsed).unwrap().is_some());
        assert_eq!(
            read_round(&conn, reparsed, 0).unwrap()["grenades"][0]["id"],
            "99999999999999999"
        );
    }

    #[test]
    fn deleted_replay_metadata_is_absent_instead_of_sql_error() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        assert!(read_replay_metadata(&conn, 1).unwrap().is_none());
        conn.execute(
            "INSERT INTO matches(id,hash,version,metadata) VALUES(1,'deleted',1,'{}')",
            [],
        )
        .unwrap();
        assert!(read_replay_metadata(&conn, 1).unwrap().is_some());
        conn.execute("DELETE FROM matches WHERE id=1", []).unwrap();
        assert!(read_replay_metadata(&conn, 1).unwrap().is_none());
        conn.execute("DROP TABLE matches", []).unwrap();
        assert!(read_replay_metadata(&conn, 1)
            .unwrap_err()
            .contains("no such table"));
    }

    #[test]
    fn missing_late_grenade_round_reports_import_context() {
        let mut conn = open(std::path::Path::new(":memory:")).unwrap();
        let source = concat!(
            "{\"type\":\"metadata\",\"format\":\"nadeviewer_replay\",\"version\":1,\"file_sha256\":\"diagnostic\"}\n",
            "{\"type\":\"round\",\"round_number\":1,\"round\":{\"number\":1}}\n",
            "{\"type\":\"grenade\",\"round_number\":0,\"grenade\":{\"id\":\"orphan\",\"release_tick\":42}}\n",
            "{\"type\":\"complete\"}\n"
        );
        let error = ingest(
            &mut conn,
            source.as_bytes(),
            "v6",
            || false,
            || {},
            || Ok(()),
        )
        .unwrap_err();
        for detail in [
            "load round for late grenades (round=0",
            "first_id=\"orphan\"",
            "release_tick=42",
            "profile: v6",
            "replay_id: Some(1)",
            "NDJSON line: 4",
            "written rounds: {1}",
            "Query returned no rows",
        ] {
            assert!(error.contains(detail), "Missing {detail} in {error}");
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM matches", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let error = read_round(&conn, 7, 12).unwrap_err();
        assert!(error.contains(
            "stage: read stored round\nreplay_id: 7\nround: 12\ncause: Query returned no rows"
        ));
    }

    #[test]
    fn local_demo_stream_round_trip() {
        let Ok(path) = std::env::var("NADE_REPLAY_STREAM") else {
            return;
        };
        let mut conn = open(std::path::Path::new(":memory:")).unwrap();
        let file = fs::File::open(path).unwrap();
        let id = ingest(
            &mut conn,
            BufReader::new(file),
            "v5",
            || false,
            || {},
            || Ok(()),
        )
        .unwrap();
        let (rounds,size):(i64,i64)=conn.query_row("SELECT (SELECT COUNT(*) FROM rounds WHERE match_id=?1),size FROM matches WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert!(rounds > 0 && size > 0);
        eprintln!("replay storage: {rounds} rounds, {size} bytes");
    }
}
