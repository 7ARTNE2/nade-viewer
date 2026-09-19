use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;
use std::{io::BufReader, path::Path};

#[derive(Deserialize)]
struct ParserEnvelope {
    canonical_grenades: Vec<Value>,
}

pub(crate) fn open(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS demos(path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL, status TEXT NOT NULL, error TEXT); CREATE TABLE IF NOT EXISTS throws(id INTEGER PRIMARY KEY, demo_path TEXT NOT NULL, ordinal INTEGER NOT NULL, raw_json TEXT NOT NULL, map TEXT, side TEXT, grenade_type TEXT, throw_keys TEXT, start_x REAL, start_y REAL, start_z REAL, explode_x REAL, explode_y REAL, explode_z REAL); CREATE INDEX IF NOT EXISTS throws_demo_ordinal ON throws(demo_path,ordinal); CREATE INDEX IF NOT EXISTS throws_lookup ON throws(map,side,grenade_type,throw_keys); CREATE INDEX IF NOT EXISTS throws_start ON throws(start_x,start_y,start_z); CREATE TABLE IF NOT EXISTS dedup(run INTEGER NOT NULL, ordinal INTEGER NOT NULL, raw_json TEXT NOT NULL, PRIMARY KEY(run,ordinal));")?;
    Ok(c)
}

pub(crate) fn import_demo(
    c: &mut Connection,
    path: &str,
    size: u64,
    modified: i64,
    items: &[Value],
) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    tx.execute("DELETE FROM throws WHERE demo_path=?", [path])?;
    // Any raw-data change makes the previously computed canonical set stale.
    tx.execute("DELETE FROM dedup", [])?;
    tx.execute("INSERT INTO demos(path,size,modified,status,error) VALUES(?,?,?,'ok',NULL) ON CONFLICT(path) DO UPDATE SET size=excluded.size,modified=excluded.modified,status='ok',error=NULL", params![path,size as i64,modified])?;
    {
        let mut insert = tx.prepare_cached("INSERT INTO throws(demo_path,ordinal,raw_json,map,side,grenade_type,throw_keys,start_x,start_y,start_z,explode_x,explode_y,explode_z) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")?;
        for (ordinal, v) in items.iter().enumerate() {
            let p = |n: &str| v.get(n).and_then(Value::as_f64);
            insert.execute(params![
                path,
                ordinal as i64,
                serde_json::to_string(v).unwrap(),
                v.get("map").and_then(Value::as_str),
                v.get("side").and_then(Value::as_str),
                v.get("grenade_type").and_then(Value::as_str),
                v.get("throw_keys").and_then(Value::as_str),
                p("start_pos_x"),
                p("start_pos_y"),
                p("start_pos_z"),
                p("explode_pos_x"),
                p("explode_pos_y"),
                p("explode_pos_z")
            ])?;
        }
    }
    tx.commit()
}

pub(crate) fn import_demo_file(
    c: &mut Connection,
    path: &str,
    size: u64,
    modified: i64,
    output_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let file = std::fs::File::open(output_path)?;
    let envelope: ParserEnvelope = serde_json::from_reader(BufReader::new(file))?;
    import_demo(c, path, size, modified, &envelope.canonical_grenades)?;
    Ok(())
}

pub(crate) fn all(c: &Connection) -> rusqlite::Result<Vec<Value>> {
    c.prepare("SELECT raw_json FROM throws ORDER BY demo_path, ordinal")?
        .query_map([], |r| {
            Ok(serde_json::from_str(r.get::<_, String>(0)?.as_str()).unwrap())
        })?
        .collect()
}

/// Visits workspace rows from one consistent read snapshot without materializing
/// the complete workspace in memory. The callback receives the stored raw JSON.
#[allow(dead_code)]
pub(crate) fn visit_rows<F>(c: &Connection, canonical: bool, mut visit: F) -> rusqlite::Result<()>
where
    F: FnMut(&str) -> rusqlite::Result<()>,
{
    let tx = c.unchecked_transaction()?;
    let sql = if canonical {
        "SELECT raw_json FROM dedup ORDER BY ordinal"
    } else {
        "SELECT raw_json FROM throws ORDER BY demo_path, ordinal"
    };
    {
        let mut statement = tx.prepare(sql)?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            let raw = row?;
            visit(&raw)?;
        }
    }
    tx.rollback()
}

pub(crate) fn counts(c: &Connection) -> rusqlite::Result<(i64, i64, i64)> {
    Ok((
        c.query_row("SELECT count(*) FROM throws", [], |r| r.get(0))?,
        c.query_row("SELECT count(*) FROM demos WHERE status='ok'", [], |r| {
            r.get(0)
        })?,
        c.query_row("SELECT count(*) FROM dedup", [], |r| r.get(0))?,
    ))
}

/// Clears every parser-workspace record while keeping the database schema.
/// VACUUM returns released pages to the filesystem after the transaction commits.
pub(crate) fn clear(c: &mut Connection) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    tx.execute_batch("DELETE FROM dedup; DELETE FROM throws; DELETE FROM demos;")?;
    tx.commit()?;
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
}
pub(crate) fn fingerprint(path: &Path) -> std::io::Result<(u64, i64)> {
    let m = std::fs::metadata(path)?;
    let t = m
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    Ok((m.len(), t))
}
pub(crate) fn unchanged(
    c: &Connection,
    path: &str,
    size: u64,
    modified: i64,
) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT count(*) FROM demos WHERE path=? AND size=? AND modified=? AND status='ok'",
        params![path, size as i64, modified],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}
pub(crate) fn replace_canonical(c: &mut Connection, items: &[Value]) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    tx.execute("DELETE FROM dedup", [])?;
    {
        let mut insert =
            tx.prepare_cached("INSERT INTO dedup(run,ordinal,raw_json) VALUES(1,?,?)")?;
        for (i, v) in items.iter().enumerate() {
            insert.execute(params![i as i64, serde_json::to_string(v).unwrap()])?;
        }
    }
    tx.commit()
}
pub(crate) fn canonical_count(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT count(*) FROM dedup", [], |r| r.get(0))
}

pub(crate) fn write_json(
    c: &Connection,
    canonical: bool,
    path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{BufWriter, Write};
    let mut out = BufWriter::new(std::fs::File::create(path)?);
    out.write_all(br#"{"version":1,"canonical_grenades":["#)?;
    let sql = if canonical {
        "SELECT raw_json FROM dedup ORDER BY ordinal"
    } else {
        "SELECT raw_json FROM throws ORDER BY demo_path, ordinal"
    };
    let mut first = true;
    let mut stmt = c.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows {
        if !first {
            out.write_all(b",")?;
        }
        first = false;
        out.write_all(row?.as_bytes())?;
    }
    out.write_all(b"]}")?;
    out.flush()?;
    Ok(())
}

pub(crate) fn write_msgpack(
    c: &Connection,
    canonical: bool,
    path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    let sql = if canonical {
        "SELECT raw_json FROM dedup ORDER BY ordinal"
    } else {
        "SELECT raw_json FROM throws ORDER BY demo_path, ordinal"
    };
    let count: u32 = if canonical {
        c.query_row("SELECT count(*) FROM dedup", [], |r| r.get(0))?
    } else {
        c.query_row("SELECT count(*) FROM throws", [], |r| r.get(0))?
    };
    rmp::encode::write_map_len(&mut out, 2)?;
    rmp_serde::encode::write_named(&mut out, &"version")?;
    rmp::encode::write_sint(&mut out, 1)?;
    rmp_serde::encode::write_named(&mut out, &"canonical_grenades")?;
    rmp::encode::write_array_len(&mut out, count)?;
    let mut stmt = c.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows {
        let value: Value = serde_json::from_str(&row?)?;
        rmp_serde::encode::write_named(&mut out, &value)?;
    }
    out.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_parser_output_from_file() {
        let dir = std::env::temp_dir().join(format!(
            "nade-parser-output-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("output.json");
        std::fs::write(
            &output,
            b"{\"version\":1,\"canonical_grenades\":[{\"map\":\"de_test\",\"trajectory\":[[1,2,3]]}]}\n",
        )
        .unwrap();
        let mut c = open(Path::new(":memory:")).unwrap();

        import_demo_file(&mut c, "a.dem", 10, 20, &output).unwrap();

        assert_eq!(counts(&c).unwrap(), (1, 1, 0));
        assert_eq!(
            all(&c).unwrap()[0]["trajectory"],
            serde_json::json!([[1, 2, 3]])
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_parser_output_does_not_replace_existing_demo() {
        let dir = std::env::temp_dir().join(format!(
            "nade-parser-invalid-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("output.json");
        std::fs::write(&output, br#"{"version":1,"canonical_grenades":["#).unwrap();
        let mut c = open(Path::new(":memory:")).unwrap();
        import_demo(&mut c, "a.dem", 1, 2, &[serde_json::json!({"id":"old"})]).unwrap();

        assert!(import_demo_file(&mut c, "a.dem", 10, 20, &output).is_err());
        assert_eq!(all(&c).unwrap()[0]["id"], "old");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rollback_preserves_raw() {
        let mut c = open(Path::new(":memory:")).unwrap();
        import_demo(
            &mut c,
            "a",
            1,
            2,
            &[serde_json::json!({"trajectory":[1,2],"id":"x"})],
        )
        .unwrap();
        assert_eq!(all(&c).unwrap()[0]["trajectory"], serde_json::json!([1, 2]));
    }

    #[test]
    fn importing_changed_raw_data_invalidates_canonical_rows() {
        let mut c = open(Path::new(":memory:")).unwrap();
        import_demo(&mut c, "a", 1, 2, &[serde_json::json!({"map":"de_test"})]).unwrap();
        replace_canonical(&mut c, &[serde_json::json!({"map":"de_test"})]).unwrap();
        assert_eq!(canonical_count(&c).unwrap(), 1);

        import_demo(
            &mut c,
            "a",
            2,
            3,
            &[serde_json::json!({"map":"de_changed"})],
        )
        .unwrap();

        assert_eq!(canonical_count(&c).unwrap(), 0);
    }

    #[test]
    fn raw_order_is_stable_after_incremental_reimport() {
        let mut c = open(Path::new(":memory:")).unwrap();
        import_demo(&mut c, "b.dem", 1, 1, &[serde_json::json!({"id":"b"})]).unwrap();
        import_demo(&mut c, "a.dem", 1, 1, &[serde_json::json!({"id":"a-old"})]).unwrap();
        import_demo(&mut c, "a.dem", 2, 2, &[serde_json::json!({"id":"a"})]).unwrap();

        let values = all(&c).unwrap();
        assert_eq!(values[0]["id"], "a");
        assert_eq!(values[1]["id"], "b");
    }

    #[test]
    fn clear_removes_raw_and_canonical_workspace_data() {
        let mut c = open(Path::new(":memory:")).unwrap();
        import_demo(
            &mut c,
            "a",
            1,
            2,
            &[serde_json::json!({"map":"de_test","start_pos_x":1.5})],
        )
        .unwrap();
        replace_canonical(&mut c, &[serde_json::json!({"map":"de_test"})]).unwrap();

        clear(&mut c).unwrap();

        assert_eq!(counts(&c).unwrap(), (0, 0, 0));
        assert_eq!(canonical_count(&c).unwrap(), 0);
    }

    #[test]
    fn json_and_msgpack_exports_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "nade-export-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = open(Path::new(":memory:")).unwrap();
        import_demo(
            &mut c,
            "a",
            1,
            2,
            &[
                serde_json::json!({"map":"de_test","start_pos_x":1.5,"trajectory":[[1,2,3]]}),
                serde_json::json!({"map":"de_dust2","start_pos_x":2.5,"extra":{"kept":true}}),
            ],
        )
        .unwrap();
        replace_canonical(
            &mut c,
            &[serde_json::json!({"map":"de_mirage","usage_count":3})],
        )
        .unwrap();

        let json_path = dir.join("raw.json");
        write_json(&c, false, &json_path).unwrap();
        let json_value: Value =
            serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(json_value["version"], 1);
        assert_eq!(
            json_value["canonical_grenades"].as_array().unwrap().len(),
            2
        );
        assert_eq!(json_value["canonical_grenades"][1]["extra"]["kept"], true);

        let msgpack_path = dir.join("raw.msgpack");
        write_msgpack(&c, false, &msgpack_path).unwrap();
        let msgpack_value: Value =
            rmp_serde::from_slice(&std::fs::read(&msgpack_path).unwrap()).unwrap();
        assert_eq!(msgpack_value, json_value);

        let canonical_path = dir.join("canonical.json");
        write_json(&c, true, &canonical_path).unwrap();
        let canonical_value: Value =
            serde_json::from_slice(&std::fs::read(&canonical_path).unwrap()).unwrap();
        assert_eq!(
            canonical_value["canonical_grenades"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(canonical_value["canonical_grenades"][0]["usage_count"], 3);
        assert_eq!(canonical_count(&c).unwrap(), 1);

        std::fs::remove_dir_all(dir).unwrap();
    }
}
