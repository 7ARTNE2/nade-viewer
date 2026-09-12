use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

pub(crate) fn open(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS demos(path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL, status TEXT NOT NULL, error TEXT); CREATE TABLE IF NOT EXISTS throws(id INTEGER PRIMARY KEY, demo_path TEXT NOT NULL, ordinal INTEGER NOT NULL, raw_json TEXT NOT NULL, map TEXT, side TEXT, grenade_type TEXT, throw_keys TEXT, start_x REAL, start_y REAL, start_z REAL, explode_x REAL, explode_y REAL, explode_z REAL); CREATE INDEX IF NOT EXISTS throws_lookup ON throws(map,side,grenade_type,throw_keys); CREATE INDEX IF NOT EXISTS throws_start ON throws(start_x,start_y,start_z); CREATE TABLE IF NOT EXISTS dedup(run INTEGER NOT NULL, ordinal INTEGER NOT NULL, raw_json TEXT NOT NULL, PRIMARY KEY(run,ordinal));")?;
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
    tx.execute("INSERT INTO demos(path,size,modified,status,error) VALUES(?,?,?,'ok',NULL) ON CONFLICT(path) DO UPDATE SET size=excluded.size,modified=excluded.modified,status='ok',error=NULL", params![path,size as i64,modified])?;
    for (ordinal, v) in items.iter().enumerate() {
        let p = |n: &str| v.get(n).and_then(Value::as_f64);
        tx.execute("INSERT INTO throws(demo_path,ordinal,raw_json,map,side,grenade_type,throw_keys,start_x,start_y,start_z,explode_x,explode_y,explode_z) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", params![path,ordinal as i64,serde_json::to_string(v).unwrap(),v.get("map").and_then(Value::as_str),v.get("side").and_then(Value::as_str),v.get("grenade_type").and_then(Value::as_str),v.get("throw_keys").and_then(Value::as_str),p("start_pos_x"),p("start_pos_y"),p("start_pos_z"),p("explode_pos_x"),p("explode_pos_y"),p("explode_pos_z")])?;
    }
    tx.commit()
}

pub(crate) fn all(c: &Connection) -> rusqlite::Result<Vec<Value>> {
    c.prepare("SELECT raw_json FROM throws ORDER BY id")?
        .query_map([], |r| {
            Ok(serde_json::from_str(r.get::<_, String>(0)?.as_str()).unwrap())
        })?
        .collect()
}

pub(crate) fn counts(c: &Connection) -> rusqlite::Result<(i64, i64)> {
    Ok((
        c.query_row("SELECT count(*) FROM throws", [], |r| r.get(0))?,
        c.query_row("SELECT count(*) FROM demos WHERE status='ok'", [], |r| {
            r.get(0)
        })?,
    ))
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
    Ok(c.query_row(
        "SELECT count(*) FROM demos WHERE path=? AND size=? AND modified=? AND status='ok'",
        params![path, size as i64, modified],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)?)
}
pub(crate) fn replace_canonical(c: &mut Connection, items: &[Value]) -> rusqlite::Result<()> {
    c.execute("DELETE FROM dedup", [])?;
    let tx = c.transaction()?;
    for (i, v) in items.iter().enumerate() {
        tx.execute(
            "INSERT INTO dedup(run,ordinal,raw_json) VALUES(1,?,?)",
            params![i as i64, serde_json::to_string(v).unwrap()],
        )?;
    }
    tx.commit()
}
pub(crate) fn canonical(c: &Connection) -> rusqlite::Result<Vec<Value>> {
    c.prepare("SELECT raw_json FROM dedup ORDER BY ordinal")?
        .query_map([], |r| {
            Ok(serde_json::from_str(&r.get::<_, String>(0)?).unwrap())
        })?
        .collect()
}

pub(crate) fn write_json(c: &Connection, canonical: bool, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{BufWriter, Write};
    let mut out = BufWriter::new(std::fs::File::create(path)?);
    out.write_all(br#"{"version":1,"canonical_grenades":["#)?;
    let sql = if canonical { "SELECT raw_json FROM dedup ORDER BY ordinal" } else { "SELECT raw_json FROM throws ORDER BY id" };
    let mut first = true;
    let mut stmt = c.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows { if !first { out.write_all(b",")?; } first=false; out.write_all(row?.as_bytes())?; }
    out.write_all(b"]}")?; out.flush()?; Ok(())
}

pub(crate) fn write_msgpack(c: &Connection, canonical: bool, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    let sql = if canonical { "SELECT raw_json FROM dedup ORDER BY ordinal" } else { "SELECT raw_json FROM throws ORDER BY id" };
    let count: u32 = if canonical { c.query_row("SELECT count(*) FROM dedup", [], |r| r.get(0))? } else { c.query_row("SELECT count(*) FROM throws", [], |r| r.get(0))? };
    rmp::encode::write_map_len(&mut out, 2)?;
    rmp_serde::encode::write_named(&mut out, &"version")?;
    rmp::encode::write_sint(&mut out, 1)?;
    rmp_serde::encode::write_named(&mut out, &"canonical_grenades")?;
    rmp::encode::write_array_len(&mut out, count)?;
    let mut stmt = c.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows { let value: Value = serde_json::from_str(&row?)?; rmp_serde::encode::write_named(&mut out, &value)?; }
    out.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
