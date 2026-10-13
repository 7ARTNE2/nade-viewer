//! Durable, immutable lineup snapshots. Source matches are disposable links.
use super::*;

pub(super) fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identity_key TEXT NOT NULL UNIQUE,
            snapshot_json TEXT NOT NULL,
            map TEXT NOT NULL, grenade_type TEXT NOT NULL, side TEXT NOT NULL,
            search_text TEXT NOT NULL,
            source_label TEXT NOT NULL, saved_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS favorite_collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS favorite_collection_members (
            collection_id INTEGER NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
            favorite_id INTEGER NOT NULL REFERENCES favorites(id) ON DELETE CASCADE,
            PRIMARY KEY(collection_id, favorite_id)
        );
        CREATE TABLE IF NOT EXISTS favorite_matches (
            grenade_id INTEGER PRIMARY KEY REFERENCES grenades(id) ON DELETE CASCADE,
            favorite_id INTEGER NOT NULL REFERENCES favorites(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_favorite_matches_favorite ON favorite_matches(favorite_id);
        CREATE INDEX IF NOT EXISTS idx_favorite_members_favorite ON favorite_collection_members(favorite_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_saved ON favorites(saved_at DESC, id DESC);",
    )?;
    Ok(())
}

pub(super) fn init_match_index(conn: &Connection) -> AppResult<()> {
    let columns = conn
        .prepare("PRAGMA table_info(grenades)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    if [
        "start_pos_x",
        "start_pos_y",
        "start_pos_z",
        "explode_pos_x",
        "explode_pos_y",
        "explode_pos_z",
    ]
    .iter()
    .any(|name| !columns.contains(*name))
    {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_grenades_favorite_identity ON grenades(
            LOWER(TRIM(map)), LOWER(TRIM(grenade_type)), LOWER(TRIM(side)),
            start_pos_x, start_pos_y, start_pos_z, explode_pos_x, explode_pos_y, explode_pos_z
        );",
    )?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    detail: GrenadeDetail,
    raw: RawGrenade,
}

fn text_key(text: Option<&str>) -> String {
    text.unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn identity(raw: &RawGrenade) -> AppResult<Option<String>> {
    let positions = [
        raw.start_pos_x,
        raw.start_pos_y,
        raw.start_pos_z,
        raw.explode_pos_x,
        raw.explode_pos_y,
        raw.explode_pos_z,
    ];
    if positions.iter().flatten().any(|v| !v.is_finite()) {
        return Ok(None);
    }
    if text_key(raw.coordinates.as_deref()).is_empty() && positions.iter().any(Option::is_none) {
        return Ok(None);
    }
    // JSON preserves nulls and exact numbers; -0 is equivalent to 0.
    let positions = positions.map(|p| p.map(|n| if n == 0.0 { 0.0 } else { n }));
    let encoded = serde_json::to_vec(&(
        text_key(Some(&raw.map)),
        text_key(raw.grenade_type.as_deref()),
        text_key(raw.side.as_deref()),
        text_key(raw.throw_keys.as_deref()),
        text_key(raw.coordinates.as_deref()),
        positions,
    ))?;
    Ok(Some(format!("v1:{:x}", Sha256::digest(encoded))))
}

fn match_snapshot(
    conn: &Connection,
    favorite_id: i64,
    raw: &RawGrenade,
    import_id: Option<i64>,
) -> AppResult<()> {
    let Some(key) = identity(raw)? else {
        return Ok(());
    };
    let mut stmt = conn.prepare(
        "SELECT g.* FROM grenades g
         WHERE LOWER(TRIM(g.map))=?1 AND LOWER(TRIM(g.grenade_type))=?2 AND LOWER(TRIM(g.side))=?3
           AND g.start_pos_x IS ?4 AND g.start_pos_y IS ?5 AND g.start_pos_z IS ?6
           AND g.explode_pos_x IS ?7 AND g.explode_pos_y IS ?8 AND g.explode_pos_z IS ?9
           AND (?10 IS NULL OR g.import_id=?10)",
    )?;
    let rows = stmt.query_map(
        params![
            text_key(Some(&raw.map)),
            text_key(raw.grenade_type.as_deref()),
            text_key(raw.side.as_deref()),
            raw.start_pos_x,
            raw.start_pos_y,
            raw.start_pos_z,
            raw.explode_pos_x,
            raw.explode_pos_y,
            raw.explode_pos_z,
            import_id
        ],
        |row| Ok((row.get::<_, i64>("id")?, raw_grenade_from_row(row)?)),
    )?;
    for row in rows {
        let (id, candidate) = row?;
        if identity(&candidate)?.as_deref() == Some(&key) {
            conn.execute(
                "INSERT OR IGNORE INTO favorite_matches(grenade_id, favorite_id) VALUES (?1, ?2)",
                params![id, favorite_id],
            )?;
        }
    }
    Ok(())
}

pub(super) fn match_import(conn: &Connection, import_id: Option<i64>) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT id, snapshot_json FROM favorites")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, json) = row?;
        let snapshot: Snapshot = serde_json::from_str(&json)?;
        match_snapshot(conn, id, &snapshot.raw, import_id)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub(super) struct FavoritePreview {
    #[serde(flatten)]
    preview: GrenadePreview,
    saved_at: String,
    source_label: String,
    collection_ids: Vec<i64>,
}

#[derive(Serialize)]
pub(super) struct FavoriteDetail {
    #[serde(flatten)]
    detail: GrenadeDetail,
    saved_at: String,
    source_label: String,
}

fn get_favorite_from_conn(conn: &Connection, id: i64) -> AppResult<FavoriteDetail> {
    let (json, saved_at, source_label): (String, String, String) = conn.query_row(
        "SELECT snapshot_json, saved_at, source_label FROM favorites WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut snapshot: Snapshot = serde_json::from_str(&json)?;
    snapshot.detail.preview.id = id;
    snapshot.detail.preview.favorite_id = Some(id);
    // Bundled radar paths can change when the application is updated.
    if let Some((main, lower, preview)) = conn.query_row(
        "SELECT map_image_path, lower_map_image_path, preview_image_path FROM map_assets WHERE name=?1",
        [&snapshot.detail.preview.map], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)),
    ).optional()? {
        snapshot.detail.map_image_path = if snapshot.detail.preview.explode_radar_level == "lower" { lower.or(main) } else { main };
        snapshot.detail.preview_image_path = preview;
    }
    Ok(FavoriteDetail {
        detail: snapshot.detail,
        saved_at,
        source_label,
    })
}

#[tauri::command]
pub(super) fn get_favorite(
    id: i64,
    state: tauri::State<'_, AppState>,
) -> AppResult<FavoriteDetail> {
    get_favorite_from_conn(&open_conn(&state)?, id)
}

#[derive(Deserialize)]
pub(super) struct FavoriteFilters {
    map: Option<String>,
    grenade_type: Option<String>,
    side: Option<String>,
    search: Option<String>,
    collection_id: Option<i64>,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Serialize)]
pub(super) struct FavoriteList {
    items: Vec<FavoritePreview>,
    total: i64,
}

fn list_from_conn(conn: &Connection, filters: FavoriteFilters) -> AppResult<FavoriteList> {
    let mut clauses = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for (column, value) in [
        ("map", filters.map),
        ("grenade_type", filters.grenade_type),
        ("side", filters.side),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty() && v != "all" && v != "Any") {
            if column == "grenade_type" && value == "molotov" {
                clauses.push("f.grenade_type IN ('molotov', 'incendiary grenade')".to_string());
            } else {
                clauses.push(format!("f.{column}=?"));
                args.push(Box::new(value));
            }
        }
    }
    if let Some(search) = filters.search.filter(|s| !s.trim().is_empty()) {
        clauses.push("f.search_text LIKE ? ESCAPE '\\'".to_string());
        args.push(Box::new(format!(
            "%{}%",
            escape_like_pattern(&search.trim().to_lowercase())
        )));
    }
    if let Some(id) = filters.collection_id {
        clauses.push("EXISTS (SELECT 1 FROM favorite_collection_members cm WHERE cm.favorite_id=f.id AND cm.collection_id=?)".to_string());
        args.push(Box::new(id));
    }
    let predicate = if clauses.is_empty() {
        "1=1".to_string()
    } else {
        clauses.join(" AND ")
    };
    let total = conn.query_row(
        &format!("SELECT COUNT(*) FROM favorites f WHERE {predicate}"),
        rusqlite::params_from_iter(args.iter().map(|v| &**v)),
        |row| row.get(0),
    )?;
    args.push(Box::new(filters.limit.unwrap_or(30).clamp(1, 100)));
    args.push(Box::new(filters.offset.unwrap_or(0)));
    let mut stmt = conn.prepare(&format!("SELECT f.id FROM favorites f WHERE {predicate} ORDER BY f.saved_at DESC, f.id DESC LIMIT ? OFFSET ?"))?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(args.iter().map(|v| &**v)),
        |row| row.get::<_, i64>(0),
    )?;
    let mut items = Vec::new();
    for id in rows {
        let id = id?;
        let favorite = get_favorite_from_conn(conn, id)?;
        items.push(FavoritePreview {
            preview: favorite.detail.preview,
            saved_at: favorite.saved_at,
            source_label: favorite.source_label,
            collection_ids: membership(conn, id)?,
        });
    }
    Ok(FavoriteList { items, total })
}

#[tauri::command]
pub(super) fn list_favorites(
    filters: FavoriteFilters,
    state: tauri::State<'_, AppState>,
) -> AppResult<FavoriteList> {
    list_from_conn(&open_conn(&state)?, filters)
}

fn favorite_root(state: &AppState) -> AppResult<PathBuf> {
    Ok(state
        .db_path
        .parent()
        .ok_or_else(|| AppError::Message("Missing application directory".into()))?
        .join("favorites"))
}

fn save_from_conn(conn: &mut Connection, state: &AppState, id: i64) -> AppResult<i64> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    active_grenade_import_id(&tx, id)?;
    let mut raw = tx.query_row(
        "SELECT * FROM grenades WHERE id=?1",
        [id],
        raw_grenade_from_row,
    )?;
    raw.usage_events = load_usage_events(&tx, id)?;
    let key = identity(&raw)?.unwrap_or_else(|| format!("source:{id}"));
    if let Some(existing) = tx
        .query_row(
            "SELECT id FROM favorites WHERE identity_key=?1",
            [&key],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        tx.execute(
            "INSERT OR IGNORE INTO favorite_matches(grenade_id, favorite_id) VALUES (?1, ?2)",
            params![id, existing],
        )?;
        tx.commit()?;
        return Ok(existing);
    }
    let detail = get_grenade_from_conn(&tx, &state.radars, id)?;
    let label: String = tx.query_row("SELECT COALESCE(NULLIF(TRIM(i.label), ''), i.source_path) FROM imports i JOIN grenades g ON g.import_id=i.id WHERE g.id=?1", [id], |row| row.get(0))?;
    let search = [
        raw.map.as_str(),
        raw.thrower.as_deref().unwrap_or(""),
        raw.thrower_team.as_deref().unwrap_or(""),
        raw.coordinates.as_deref().unwrap_or(""),
        raw.throw_keys.as_deref().unwrap_or(""),
        &label,
    ]
    .join(" ")
    .to_lowercase();
    tx.execute("INSERT INTO favorites(identity_key, snapshot_json, map, grenade_type, side, search_text, source_label, saved_at) VALUES (?1, '', ?2, ?3, ?4, ?5, ?6, ?7)",
        params![key, raw.map, detail.preview.grenade_type, detail.preview.side, search, label, Utc::now().to_rfc3339()])?;
    let favorite_id = tx.last_insert_rowid();
    let folder = favorite_root(state)?.join(favorite_id.to_string());
    let saved = (|| -> AppResult<()> {
        let mut snapshot = Snapshot { detail, raw };
        for (name, image) in [
            ("normal", &mut snapshot.detail.screenshot_image_path),
            ("wide", &mut snapshot.detail.screenshot_wide_image_path),
        ] {
            if let Some(source) = image.as_ref() {
                fs::create_dir_all(&folder)?;
                let extension = Path::new(source)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("jpg");
                let destination = folder.join(format!("{name}.{extension}"));
                fs::copy(source, &destination)?;
                *image = Some(destination.to_string_lossy().into_owned());
            }
        }
        tx.execute(
            "UPDATE favorites SET snapshot_json=?1 WHERE id=?2",
            params![serde_json::to_string(&snapshot)?, favorite_id],
        )?;
        tx.execute(
            "INSERT INTO favorite_matches(grenade_id, favorite_id) VALUES (?1, ?2)",
            params![id, favorite_id],
        )?;
        match_snapshot(&tx, favorite_id, &snapshot.raw, None)?;
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = saved {
        let _ = fs::remove_dir_all(&folder);
        return Err(error);
    }
    Ok(favorite_id)
}

#[tauri::command]
pub(super) async fn save_favorite(id: i64, state: tauri::State<'_, AppState>) -> AppResult<i64> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_from_conn(&mut open_conn(&state)?, &state, id)
    })
    .await
    .map_err(|e| AppError::Message(e.to_string()))?
}

fn delete_from_conn(conn: &mut Connection, state: &AppState, id: i64) -> AppResult<()> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let changed = tx.execute("DELETE FROM favorites WHERE id=?1", [id])?;
    if changed == 0 {
        return Err(AppError::Message("Favorite not found".into()));
    }
    tx.commit()?;
    // Cleanup is best effort after committing. A leftover file must not resurrect a snapshot.
    let folder = favorite_root(state)?.join(id.to_string());
    if folder.exists() {
        if let Err(e) = fs::remove_dir_all(folder) {
            eprintln!("Favorite image cleanup failed: {e}");
        }
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn delete_favorite(id: i64, state: tauri::State<'_, AppState>) -> AppResult<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        delete_from_conn(&mut open_conn(&state)?, &state, id)
    })
    .await
    .map_err(|e| AppError::Message(e.to_string()))?
}

#[derive(Serialize)]
pub(super) struct FavoriteCollection {
    id: i64,
    name: String,
    grenade_count: i64,
}

#[derive(Serialize)]
pub(super) struct FavoriteState {
    collections: Vec<FavoriteCollection>,
    maps: Vec<String>,
    favorites: BTreeMap<i64, Vec<i64>>,
    source_matches: BTreeMap<i64, i64>,
}

fn membership(conn: &Connection, id: i64) -> AppResult<Vec<i64>> {
    Ok(conn.prepare("SELECT collection_id FROM favorite_collection_members WHERE favorite_id=?1 ORDER BY collection_id")?
        .query_map([id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?)
}

fn state_from_conn(conn: &Connection) -> AppResult<FavoriteState> {
    let collections = conn.prepare("SELECT c.id, c.name, COUNT(cm.favorite_id) FROM favorite_collections c LEFT JOIN favorite_collection_members cm ON cm.collection_id=c.id GROUP BY c.id ORDER BY c.id")?
        .query_map([], |row| Ok(FavoriteCollection { id: row.get(0)?, name: row.get(1)?, grenade_count: row.get(2)? }))?.collect::<Result<Vec<_>, _>>()?;
    let maps = conn
        .prepare("SELECT DISTINCT map FROM favorites ORDER BY map")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let ids = conn
        .prepare("SELECT id FROM favorites")?
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut favorites = BTreeMap::new();
    for id in ids {
        favorites.insert(id, membership(conn, id)?);
    }
    let source_matches = conn.prepare("SELECT fm.grenade_id, fm.favorite_id FROM favorite_matches fm JOIN grenades g ON g.id=fm.grenade_id WHERE g.import_id=(SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='active_import_id')")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(FavoriteState {
        collections,
        maps,
        favorites,
        source_matches,
    })
}

#[tauri::command]
pub(super) fn get_favorites_state(state: tauri::State<'_, AppState>) -> AppResult<FavoriteState> {
    state_from_conn(&open_conn(&state)?)
}

fn collection_name(name: String) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::Message(
            "Collection name must contain 1–100 characters".into(),
        ));
    }
    Ok(name.to_string())
}

#[tauri::command]
pub(super) fn create_favorite_collection(
    name: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<i64> {
    let conn = open_conn(&state)?;
    conn.execute(
        "INSERT INTO favorite_collections(name) VALUES (?1)",
        [collection_name(name)?],
    )?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub(super) fn rename_favorite_collection(
    id: i64,
    name: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    let conn = open_conn(&state)?;
    if conn.execute(
        "UPDATE favorite_collections SET name=?1 WHERE id=?2",
        params![collection_name(name)?, id],
    )? == 0
    {
        return Err(AppError::Message("Collection not found".into()));
    }
    Ok(())
}

#[tauri::command]
pub(super) fn delete_favorite_collection(
    id: i64,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    let conn = open_conn(&state)?;
    if conn.execute("DELETE FROM favorite_collections WHERE id=?1", [id])? == 0 {
        return Err(AppError::Message("Collection not found".into()));
    }
    Ok(())
}

fn set_membership(conn: &mut Connection, id: i64, collection_ids: Vec<i64>) -> AppResult<()> {
    let tx = conn.transaction()?;
    if !tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM favorites WHERE id=?1)",
        [id],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::Message("Favorite not found".into()));
    }
    tx.execute(
        "DELETE FROM favorite_collection_members WHERE favorite_id=?1",
        [id],
    )?;
    for collection in collection_ids.into_iter().collect::<BTreeSet<_>>() {
        tx.execute(
            "INSERT INTO favorite_collection_members(collection_id, favorite_id) VALUES (?1, ?2)",
            params![collection, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub(super) fn set_favorite_collections(
    id: i64,
    collection_ids: Vec<i64>,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    set_membership(&mut open_conn(&state)?, id, collection_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        state: AppState,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().join(format!(
                "nade-favorites-{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap()
            ));
            fs::create_dir_all(&root).unwrap();
            let state = AppState {
                db_path: root.join("test.sqlite"),
                resource_dir: root.join("resources"),
                radars: Arc::new(HashMap::new()),
                import_status: Arc::new(Mutex::new(ImportStatus::default())),
                library_download_cancelled: Arc::new(AtomicBool::new(false)),
                manual_import: Arc::new(ManualImportControl::default()),
                emitter: None,
            };
            super::super::init_schema(&open_conn(&state).unwrap()).unwrap();
            Self { state, root }
        }
        fn import(&self, usage: i64, complete: bool) -> (i64, i64) {
            let positions = if complete {
                r#", "start_pos_x":1, "start_pos_y":2, "start_pos_z":3, "explode_pos_x":4, "explode_pos_y":5, "explode_pos_z":6, "coordinates":"setpos 1 2 3; setang 10 20 0""#
            } else {
                ""
            };
            let json = format!(
                r#"{{"canonical_grenades":[{{"map":"de_test","grenade_type":"smoke","side":"T","throw_keys":"M1+JUMP","thrower":"Player {usage}","usage_count":{usage},"round_time_seconds":42,"trajectory":[[1,2,3],[4,5,6]],"trajectory_preview":[[10,20],[30,40]],"usage_events":[{{"thrower":"Alice","demo_filename":"Cup.dem","throw_tick":100}}]{positions}}}]}}"#
            );
            let report = import_index_blocking(
                &self.state,
                "library.json",
                parse_import(json.as_bytes()).unwrap(),
                None,
            )
            .unwrap();
            let conn = open_conn(&self.state).unwrap();
            let id = conn
                .query_row(
                    "SELECT id FROM grenades WHERE import_id=?1",
                    [report.import_id],
                    |r| r.get(0),
                )
                .unwrap();
            (report.import_id, id)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn filters() -> FavoriteFilters {
        FavoriteFilters {
            map: None,
            grenade_type: None,
            side: None,
            search: None,
            collection_id: None,
            limit: None,
            offset: None,
        }
    }

    #[test]
    fn snapshot_matches_existing_and_new_imports_without_changing_saved_data() {
        let fixture = Fixture::new();
        let (_, first) = fixture.import(3, true);
        let (second_import, second) = fixture.import(9, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        set_active_import_in_conn(&conn, second_import).unwrap();
        let id = save_from_conn(&mut conn, &fixture.state, second).unwrap();
        let state = state_from_conn(&conn).unwrap();
        assert_eq!(state.source_matches.get(&second), Some(&id));
        assert_eq!(
            conn.query_row(
                "SELECT favorite_id FROM favorite_matches WHERE grenade_id=?1",
                [first],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            id
        );
        assert_eq!(
            save_from_conn(&mut conn, &fixture.state, second).unwrap(),
            id
        );
        let (_, third) = fixture.import(50, true);
        assert_eq!(
            save_from_conn(&mut conn, &fixture.state, third).unwrap(),
            id
        );
        let saved = get_favorite_from_conn(&conn, id).unwrap().detail;
        assert_eq!(saved.preview.usage_count, 9);
        assert_eq!(saved.preview.thrower.as_deref(), Some("Player 9"));
        assert_eq!(saved.preview.round_time_seconds, Some(42.0));
        assert_eq!(saved.preview.explode_pos_z, Some(6.0));
        assert_eq!(saved.preview.favorite_id, Some(id));
        assert_eq!(saved.usage_stats.tracked_throws, 1);
        let json: String = conn
            .query_row(
                "SELECT snapshot_json FROM favorites WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let snapshot: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot.raw.trajectory.unwrap().len(), 2);
        assert_eq!(snapshot.raw.usage_events.len(), 1);
    }

    #[test]
    fn incomplete_lineups_stay_distinct_and_changed_positions_do_not_match() {
        let fixture = Fixture::new();
        let (_, first) = fixture.import(1, false);
        let mut conn = open_conn(&fixture.state).unwrap();
        let a = save_from_conn(&mut conn, &fixture.state, first).unwrap();
        let (_, second) = fixture.import(1, false);
        assert!(!state_from_conn(&conn)
            .unwrap()
            .source_matches
            .contains_key(&second));
        let b = save_from_conn(&mut conn, &fixture.state, second).unwrap();
        assert_ne!(a, b);
        let (_, complete) = fixture.import(1, true);
        let c = save_from_conn(&mut conn, &fixture.state, complete).unwrap();
        let (_, moved) = fixture.import(1, true);
        conn.execute("DELETE FROM favorite_matches WHERE grenade_id=?1", [moved])
            .unwrap();
        conn.execute(
            "UPDATE grenades SET start_pos_x=1.000001 WHERE id=?1",
            [moved],
        )
        .unwrap();
        match_import(&conn, None).unwrap();
        assert!(!state_from_conn(&conn)
            .unwrap()
            .source_matches
            .contains_key(&moved));
        assert_ne!(save_from_conn(&mut conn, &fixture.state, moved).unwrap(), c);
        // A coordinate string is sufficient even when world positions are incomplete.
        let mut raw = conn
            .query_row(
                "SELECT * FROM grenades WHERE id=?1",
                [first],
                raw_grenade_from_row,
            )
            .unwrap();
        raw.coordinates = Some(" setpos 1 2 3 ".into());
        let mut other = raw.clone();
        other.coordinates = Some("SETPOS   1 2 3".into());
        assert_eq!(identity(&raw).unwrap(), identity(&other).unwrap());
    }

    #[test]
    fn survives_last_library_deletion_and_reopen_with_both_images() {
        let fixture = Fixture::new();
        let (import, source) = fixture.import(5, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        let screenshot_root = fixture.root.join("screenshots").join(import.to_string());
        fs::create_dir_all(&screenshot_root).unwrap();
        let normal = screenshot_root.join("normal.jpg");
        let wide = screenshot_root.join("wide.jpg");
        fs::write(&normal, b"normal image").unwrap();
        fs::write(&wide, b"wide image").unwrap();
        conn.execute("INSERT INTO grenade_screenshots(import_id, grenade_id, image_path, wide_image_path, wide_fov, width, height, file_size, wide_file_size, captured_at) SELECT import_id, id, ?2, ?3, 90, 1920, 1080, 1, 1, 'now' FROM grenades WHERE id=?1", params![source, normal.to_string_lossy(), wide.to_string_lossy()]).unwrap();
        let id = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        assert!(delete_import_from_conn(&mut conn, import)
            .unwrap()
            .is_none());
        fs::remove_dir_all(&screenshot_root).unwrap();
        drop(conn);
        let mut conn = open_conn(&fixture.state).unwrap();
        super::super::init_schema(&conn).unwrap();
        let saved = get_favorite_from_conn(&conn, id).unwrap().detail;
        assert_eq!(
            fs::read(saved.screenshot_image_path.unwrap()).unwrap(),
            b"normal image"
        );
        assert_eq!(
            fs::read(saved.screenshot_wide_image_path.unwrap()).unwrap(),
            b"wide image"
        );
        assert_eq!(list_from_conn(&conn, filters()).unwrap().total, 1);
        assert!(state_from_conn(&conn).unwrap().source_matches.is_empty());
        delete_from_conn(&mut conn, &fixture.state, id).unwrap();
        assert!(!favorite_root(&fixture.state)
            .unwrap()
            .join(id.to_string())
            .exists());
    }

    #[test]
    fn missing_wide_image_rolls_back_database_and_copied_normal_image() {
        let fixture = Fixture::new();
        let (_, source) = fixture.import(5, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        let normal = fixture.root.join("normal.jpg");
        fs::write(&normal, b"normal").unwrap();
        conn.execute("INSERT INTO grenade_screenshots(import_id, grenade_id, image_path, wide_image_path, wide_fov, width, height, file_size, wide_file_size, captured_at) SELECT import_id, id, ?2, ?3, 90, 1920, 1080, 1, 1, 'now' FROM grenades WHERE id=?1", params![source, normal.to_string_lossy(), fixture.root.join("missing.jpg").to_string_lossy()]).unwrap();
        assert!(save_from_conn(&mut conn, &fixture.state, source).is_err());
        assert_eq!(list_from_conn(&conn, filters()).unwrap().total, 0);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM favorite_matches", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            fs::read_dir(favorite_root(&fixture.state).unwrap())
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn collection_membership_is_atomic_and_deleting_collection_preserves_favorite() {
        let fixture = Fixture::new();
        let (_, source) = fixture.import(1, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        let id = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        conn.execute(
            "INSERT INTO favorite_collections(id, name) VALUES (1, 'A'), (2, 'B')",
            [],
        )
        .unwrap();
        set_membership(&mut conn, id, vec![1, 2, 1]).unwrap();
        assert_eq!(membership(&conn, id).unwrap(), vec![1, 2]);
        assert!(set_membership(&mut conn, id, vec![2, 999]).is_err());
        assert_eq!(membership(&conn, id).unwrap(), vec![1, 2]);
        conn.execute("DELETE FROM favorite_collections WHERE id=1", [])
            .unwrap();
        assert_eq!(membership(&conn, id).unwrap(), vec![2]);
        assert_eq!(list_from_conn(&conn, filters()).unwrap().total, 1);
        set_membership(&mut conn, id, vec![]).unwrap();
        assert!(membership(&conn, id).unwrap().is_empty());
        delete_from_conn(&mut conn, &fixture.state, id).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM favorite_matches", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(collection_name(" ".into()).is_err());
        assert!(collection_name("a".repeat(101)).is_err());
    }

    #[test]
    fn favorite_filter_combines_with_type_side_search_and_cluster_modes() {
        let fixture = Fixture::new();
        let (_, source) = fixture.import(1, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        let id = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        let (active, matching) = fixture.import(8, true);
        conn.execute(
            "INSERT INTO favorite_collections(id, name) VALUES (1, 'Practice'), (2, 'Empty')",
            [],
        )
        .unwrap();
        set_membership(&mut conn, id, vec![1]).unwrap();
        conn.execute("UPDATE grenades SET start_map_x=20, start_map_y=20, explode_map_x=40, explode_map_y=40", []).unwrap();
        conn.execute("INSERT INTO grenades(import_id, source_index, map, grenade_type, side, usage_count, start_map_x, start_map_y, explode_map_x, explode_map_y) VALUES (?1, 2, 'de_test', 'smoke', 'T', 99, 20, 20, 40, 40)", [active]).unwrap();
        let query = |conn: &Connection, collection, side: &str, coord: &str| {
            let filters = MapFilters {
                favorites_only: Some(true),
                favorite_collection_id: Some(collection),
                grenade_type: Some("smoke".into()),
                side: Some(side.into()),
                search: Some("Player".into()),
                min_usage: Some(2),
                ..Default::default()
            };
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(active)];
            let visibility = visibility_sql(conn, &mut args, "g").unwrap();
            let predicate = filter_sql(&filters, &mut args, "g");
            let sql = format!("SELECT g.id FROM grenades g WHERE g.import_id=?{visibility}{predicate} AND g.{coord}_map_x IS NOT NULL");
            conn.prepare(&sql)
                .unwrap()
                .query_map(rusqlite::params_from_iter(args.iter().map(|a| &**a)), |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(query(&conn, 1, "T", "start"), vec![matching]);
        assert_eq!(query(&conn, 1, "T", "explode"), vec![matching]);
        assert!(query(&conn, 1, "CT", "start").is_empty());
        assert!(query(&conn, 2, "T", "explode").is_empty());
        delete_from_conn(&mut conn, &fixture.state, id).unwrap();
        assert!(query(&conn, 1, "T", "start").is_empty());
    }

    #[test]
    fn list_filters_literal_search_and_pagination() {
        let fixture = Fixture::new();
        let (_, source) = fixture.import(1, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        let id = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        for ordinal in 0..35 {
            conn.execute("INSERT INTO favorites(identity_key, snapshot_json, map, grenade_type, side, search_text, source_label, saved_at) SELECT ?1, snapshot_json, map, grenade_type, side, 'Player 100%', source_label, saved_at FROM favorites WHERE id=?2", params![format!("test-{ordinal}"), id]).unwrap();
        }
        let page = list_from_conn(&conn, filters()).unwrap();
        assert_eq!(page.total, 36);
        assert_eq!(page.items.len(), 30);
        let mut second = filters();
        second.offset = Some(30);
        assert_eq!(list_from_conn(&conn, second).unwrap().items.len(), 6);
        let mut search = filters();
        search.search = Some("100%".into());
        assert_eq!(list_from_conn(&conn, search).unwrap().total, 35);
        let mut no = filters();
        no.side = Some("CT".into());
        assert_eq!(list_from_conn(&conn, no).unwrap().total, 0);
    }
}
