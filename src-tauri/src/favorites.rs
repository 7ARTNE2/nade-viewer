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
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, map TEXT
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
    migrate_collection_maps(conn)
}

fn migrate_collection_maps(conn: &Connection) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let columns = tx
        .prepare("PRAGMA table_info(favorite_collections)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    if !columns.contains("map") {
        tx.execute("ALTER TABLE favorite_collections ADD COLUMN map TEXT", [])?;
    }
    let collections = tx
        .prepare("SELECT id, name FROM favorite_collections WHERE map IS NULL ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, name) in collections {
        let maps = tx.prepare("SELECT DISTINCT f.map FROM favorites f JOIN favorite_collection_members cm ON cm.favorite_id=f.id WHERE cm.collection_id=?1 ORDER BY f.map")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for (index, map) in maps.iter().enumerate() {
            if index == 0 {
                tx.execute(
                    "UPDATE favorite_collections SET map=?1 WHERE id=?2",
                    params![map, id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO favorite_collections(name, map) VALUES (?1, ?2)",
                    params![name, map],
                )?;
                let new_id = tx.last_insert_rowid();
                tx.execute("UPDATE favorite_collection_members SET collection_id=?1 WHERE collection_id=?2 AND favorite_id IN (SELECT id FROM favorites WHERE map=?3)", params![new_id, id, map])?;
            }
        }
    }
    tx.commit()?;
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
    #[serde(default)]
    demo_metadata: BTreeMap<String, (String, String)>,
}

fn snapshot_demo_metadata(
    conn: &Connection,
    raw: &RawGrenade,
    source_id: i64,
) -> AppResult<BTreeMap<String, (String, String)>> {
    let mut metadata = BTreeMap::new();
    let import_id: Option<i64> = conn
        .query_row(
            "SELECT import_id FROM grenades WHERE id=?1",
            [source_id],
            |row| row.get(0),
        )
        .optional()?;
    for filename in raw.demo_filename.iter().chain(
        raw.usage_events
            .iter()
            .filter_map(|event| event.demo_filename.as_ref()),
    ) {
        if let Some(import_id) = import_id {
            if let Some(value) = conn.query_row("SELECT tournament, demo_date FROM demo_metadata WHERE import_id=?1 AND demo_filename=?2", params![import_id, filename], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional()? {
                metadata.insert(filename.clone(), value);
                continue;
            }
        }
        record_demo_metadata(&mut metadata, Some(filename), raw.tournament.as_deref());
    }
    Ok(metadata)
}

pub(super) fn backfill_snapshot_metadata(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT id, snapshot_json FROM favorites WHERE json_type(snapshot_json, '$.demo_metadata') IS NULL AND snapshot_json != ''")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, json) in rows {
        let mut snapshot: Snapshot = serde_json::from_str(&json)?;
        snapshot.demo_metadata =
            snapshot_demo_metadata(conn, &snapshot.raw, snapshot.detail.preview.id)?;
        conn.execute(
            "UPDATE favorites SET snapshot_json=?1 WHERE id=?2",
            params![serde_json::to_string(&snapshot)?, id],
        )?;
    }
    Ok(())
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

#[derive(Default, Deserialize)]
pub(super) struct FavoriteFilters {
    map: Option<String>,
    grenade_type: Option<String>,
    side: Option<String>,
    search: Option<String>,
    collection_id: Option<i64>,
    limit: Option<u32>,
    offset: Option<u32>,
    movement: Option<MovementFilter>,
    jump: Option<JumpFilter>,
    is_insta: Option<bool>,
    radar_level: Option<String>,
    thrower_team: Option<Vec<String>>,
    thrower_steamid64: Option<Vec<String>>,
    tournament: Option<Vec<String>>,
    min_usage: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct FavoriteList {
    items: Vec<FavoritePreview>,
    total: i64,
}

// Project only the snapshot fields used by map filters. No source-import joins:
// favorite IDs and source grenade IDs belong to separate namespaces.
const FAVORITE_MAP_CTE: &str = "WITH g AS (SELECT f.*,
    json_extract(snapshot_json, '$.detail.throw_keys') AS throw_keys,
    json_extract(snapshot_json, '$.detail.start_map_x') AS start_map_x,
    json_extract(snapshot_json, '$.detail.start_map_y') AS start_map_y,
    json_extract(snapshot_json, '$.detail.explode_map_x') AS explode_map_x,
    json_extract(snapshot_json, '$.detail.explode_map_y') AS explode_map_y,
    json_extract(snapshot_json, '$.detail.explode_pos_z') AS explode_pos_z
    FROM favorites f)";

fn favorite_predicate(
    filters: &FavoriteFilters,
) -> AppResult<(String, Vec<Box<dyn rusqlite::ToSql>>)> {
    let mut clauses = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for (column, value) in [
        ("map", filters.map.as_deref()),
        ("grenade_type", filters.grenade_type.as_deref()),
        ("side", filters.side.as_deref()),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty() && *v != "all" && *v != "Any") {
            if column == "grenade_type" && value == "molotov" {
                clauses.push("g.grenade_type IN ('molotov', 'incendiary grenade')".to_string());
            } else {
                clauses.push(format!("g.{column}=?"));
                args.push(Box::new(value.to_string()));
            }
        }
    }
    if let Some(search) = filters.search.as_deref().filter(|s| !s.trim().is_empty()) {
        clauses.push("g.search_text LIKE ? ESCAPE '\\'".to_string());
        args.push(Box::new(format!(
            "%{}%",
            escape_like_pattern(&search.trim().to_lowercase())
        )));
    }
    if let Some(id) = filters.collection_id {
        clauses.push("EXISTS (SELECT 1 FROM favorite_collection_members cm WHERE cm.favorite_id=g.id AND cm.collection_id=?)".to_string());
        args.push(Box::new(id));
    }
    let teams = normalized_selection(filters.thrower_team.as_deref().unwrap_or_default());
    if !teams.is_empty() {
        let conditions = teams.iter().map(|team| {
            let pattern = format!("%{}%", escape_like_pattern(&team.to_lowercase()));
            args.push(Box::new(pattern.clone()) as Box<dyn rusqlite::ToSql>);
            args.push(Box::new(pattern));
            "(LOWER(COALESCE(json_extract(g.snapshot_json, '$.raw.thrower_team'), '')) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(g.snapshot_json, '$.raw.usage_events') ue WHERE LOWER(COALESCE(json_extract(ue.value, '$.thrower_team'), '')) LIKE ? ESCAPE '\\'))"
        }).collect::<Vec<_>>();
        clauses.push(format!("({})", conditions.join(" OR ")));
    }
    let players = normalized_selection(filters.thrower_steamid64.as_deref().unwrap_or_default());
    if !players.is_empty() {
        let placeholders = selection_placeholders(players.len());
        clauses.push(format!("(json_extract(g.snapshot_json, '$.raw.thrower_steamid64') IN ({placeholders}) OR EXISTS (SELECT 1 FROM json_each(g.snapshot_json, '$.raw.usage_events') ue WHERE json_extract(ue.value, '$.thrower_steamid64') IN ({placeholders})))"));
        for _ in 0..2 {
            for player in &players {
                args.push(Box::new((*player).to_string()));
            }
        }
    }
    let tournaments = normalized_selection(filters.tournament.as_deref().unwrap_or_default());
    if !tournaments.is_empty() {
        clauses.push(format!("EXISTS (SELECT 1 FROM json_each(g.snapshot_json, '$.demo_metadata') dm WHERE json_extract(dm.value, '$[0]') IN ({}))", selection_placeholders(tournaments.len())));
        for tournament in tournaments {
            args.push(Box::new(tournament.to_string()));
        }
    }
    if let Some(min_usage) = filters.min_usage.filter(|value| *value > 0) {
        clauses.push("json_extract(g.snapshot_json, '$.detail.usage_count') >= ?".into());
        args.push(Box::new(min_usage));
    }
    let mut predicate = if clauses.is_empty() {
        "1=1".to_string()
    } else {
        clauses.join(" AND ")
    };
    predicate.push_str(&filter_sql(
        &MapFilters {
            movement: filters.movement,
            jump: filters.jump,
            is_insta: filters.is_insta,
            ..Default::default()
        },
        &mut args,
        "g",
    ));
    Ok((predicate, args))
}

#[cfg(test)]
fn list_from_conn(conn: &Connection, filters: FavoriteFilters) -> AppResult<FavoriteList> {
    list_with_radars(conn, &HashMap::new(), filters)
}

fn list_with_radars(
    conn: &Connection,
    radars: &HashMap<String, RadarParams>,
    filters: FavoriteFilters,
) -> AppResult<FavoriteList> {
    let (mut predicate, mut args) = favorite_predicate(&filters)?;
    if let Some(map) = filters.map.as_deref().filter(|m| !m.is_empty()) {
        let summary = map_asset_summary(conn, radars, map)?;
        predicate.push_str(&radar_level_sql(
            filters.radar_level.as_deref(),
            &summary,
            &mut args,
            "g",
        ));
    }
    let total = conn.query_row(
        &format!("{FAVORITE_MAP_CTE} SELECT COUNT(*) FROM g WHERE {predicate}"),
        rusqlite::params_from_iter(args.iter().map(|v| &**v)),
        |row| row.get(0),
    )?;
    args.push(Box::new(filters.limit.unwrap_or(30).clamp(1, 100)));
    args.push(Box::new(filters.offset.unwrap_or(0)));
    let pagination = if filters.limit == Some(0) {
        args.truncate(args.len() - 2);
        ""
    } else {
        " LIMIT ? OFFSET ?"
    };
    let mut stmt = conn.prepare(&format!("{FAVORITE_MAP_CTE} SELECT g.id FROM g WHERE {predicate} ORDER BY g.saved_at DESC, g.id DESC{pagination}"))?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(args.iter().map(|v| &**v)),
        |row| row.get::<_, i64>(0),
    )?;
    let mut items = Vec::new();
    for id in rows {
        let id = id?;
        let mut favorite = get_favorite_from_conn(conn, id)?;
        let summary = map_asset_summary(conn, radars, &favorite.detail.preview.map)?;
        favorite.detail.preview.explode_radar_level = classify_radar_level(
            favorite.detail.preview.explode_pos_z,
            summary.radar_split_z,
            summary.has_lower_radar,
        );
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
    list_with_radars(&open_conn(&state)?, &state.radars, filters)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum FavoriteMapMode {
    Landing,
    Throw,
}

impl FavoriteMapMode {
    fn coord(self) -> &'static str {
        match self {
            Self::Landing => "explode",
            Self::Throw => "start",
        }
    }

    fn point(self, preview: &GrenadePreview) -> Option<(f64, f64)> {
        let (x, y) = match self {
            Self::Landing => (preview.explode_map_x, preview.explode_map_y),
            Self::Throw => (preview.start_map_x, preview.start_map_y),
        };
        x.zip(y).filter(|(x, y)| x.is_finite() && y.is_finite())
    }

    fn cell(self, preview: &GrenadePreview) -> Option<(i64, i64)> {
        let size = cluster_cell_size(self.coord()) as f64;
        self.point(preview)
            .map(|(x, y)| ((x / size) as i64, (y / size) as i64))
    }
}

fn favorite_maps_from_conn(
    conn: &Connection,
    radars: &HashMap<String, RadarParams>,
) -> AppResult<Vec<MapSummary>> {
    let mut stmt = conn.prepare(
        "SELECT m.name, COUNT(f.id) FROM (
        SELECT name FROM map_assets UNION SELECT map FROM favorites
        UNION SELECT map FROM favorite_collections WHERE map IS NOT NULL
        ) m LEFT JOIN favorites f ON f.map=m.name GROUP BY m.name
        ORDER BY COALESCE((SELECT label FROM map_assets WHERE name=m.name), m.name), m.name",
    )?;
    let maps = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    maps.into_iter()
        .map(|(map, count)| {
            let mut summary = map_asset_summary(conn, radars, &map)?;
            summary.grenade_count = count;
            Ok(summary)
        })
        .collect()
}

#[tauri::command]
pub(super) fn get_favorite_maps(state: tauri::State<'_, AppState>) -> AppResult<Vec<MapSummary>> {
    favorite_maps_from_conn(&open_conn(&state)?, &state.radars)
}

#[derive(Serialize)]
pub(super) struct FavoriteFilterOptions {
    players: Vec<ImportPlayer>,
    tournaments: Vec<ImportTournament>,
}

fn filter_options_from_conn(
    conn: &Connection,
    filters: FavoriteFilters,
) -> AppResult<FavoriteFilterOptions> {
    let selected_tournaments =
        normalized_selection(filters.tournament.as_deref().unwrap_or_default());
    let (predicate, args) = favorite_predicate(&FavoriteFilters {
        map: filters.map.clone(),
        collection_id: filters.collection_id,
        ..Default::default()
    })?;
    let mut stmt = conn.prepare(&format!(
        "{FAVORITE_MAP_CTE} SELECT snapshot_json FROM g WHERE {predicate} ORDER BY id"
    ))?;
    let jsons = stmt
        .query_map(
            rusqlite::params_from_iter(args.iter().map(|arg| &**arg)),
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut players = BTreeSet::new();
    let mut tournaments: BTreeMap<String, (String, String)> = BTreeMap::new();
    for json in jsons {
        let snapshot: Snapshot = serde_json::from_str(&json)?;
        for (name, date) in snapshot.demo_metadata.values() {
            let range = tournaments
                .entry(name.clone())
                .or_insert((date.clone(), date.clone()));
            range.0 = range.0.clone().min(date.clone());
            range.1 = range.1.clone().max(date.clone());
        }
        let in_scope = |demo: Option<&str>| {
            selected_tournaments.is_empty()
                || demo
                    .and_then(|name| snapshot.demo_metadata.get(name))
                    .is_some_and(|(name, _)| selected_tournaments.contains(&name.as_str()))
        };
        let raw = &snapshot.raw;
        let mut add_player = |steam: Option<&str>, name: Option<&str>, team: Option<&str>| {
            if let Some(steam) = steam.map(str::trim).filter(|s| !s.is_empty()) {
                players.insert((
                    steam.to_string(),
                    name.unwrap_or_default().to_string(),
                    team.unwrap_or_default().to_string(),
                    raw.side.clone().unwrap_or_default(),
                ));
            }
        };
        if in_scope(raw.demo_filename.as_deref()) {
            add_player(
                raw.thrower_steamid64.as_deref(),
                raw.thrower.as_deref(),
                raw.thrower_team.as_deref(),
            );
        }
        for event in &raw.usage_events {
            if in_scope(event.demo_filename.as_deref()) {
                add_player(
                    event.thrower_steamid64.as_deref(),
                    event.thrower.as_deref(),
                    event.thrower_team.as_deref(),
                );
            }
        }
    }
    Ok(FavoriteFilterOptions {
        players: players
            .into_iter()
            .map(|(steamid64, name, team_name, side)| ImportPlayer {
                steamid64,
                name,
                team_name,
                side,
            })
            .collect(),
        tournaments: tournaments
            .into_iter()
            .map(|(name, (start_date, end_date))| ImportTournament {
                name,
                start_date,
                end_date,
            })
            .collect(),
    })
}

#[tauri::command]
pub(super) fn get_favorite_filter_options(
    filters: FavoriteFilters,
    state: tauri::State<'_, AppState>,
) -> AppResult<FavoriteFilterOptions> {
    filter_options_from_conn(&open_conn(&state)?, filters)
}

fn favorite_overview_from_conn(
    conn: &Connection,
    radars: &HashMap<String, RadarParams>,
    map: String,
    mut filters: FavoriteFilters,
    mode: FavoriteMapMode,
) -> AppResult<MapOverview> {
    filters.map = Some(map.clone());
    filters.limit = Some(0);
    filters.offset = None;
    let requested_level = filters
        .radar_level
        .clone()
        .unwrap_or_else(|| "default".into());
    let list = list_with_radars(conn, radars, filters)?;
    let mut summary = map_asset_summary(conn, radars, &map)?;
    let cluster_radar_level = if summary.has_lower_radar {
        requested_level
    } else {
        "default".into()
    };
    summary.grenade_count = conn.query_row(
        "SELECT COUNT(*) FROM favorites WHERE map=?1",
        [&map],
        |row| row.get(0),
    )?;
    let mut type_counts = BTreeMap::new();
    let mut side_counts = BTreeMap::new();
    let mut groups: BTreeMap<(i64, i64), Vec<&GrenadePreview>> = BTreeMap::new();
    for item in &list.items {
        let p = &item.preview;
        *type_counts.entry(p.grenade_type.clone()).or_insert(0) += 1;
        *side_counts.entry(p.side.clone()).or_insert(0) += 1;
        if let Some(cell) = mode.cell(p) {
            groups.entry(cell).or_default().push(p);
        }
    }
    let mut clusters: Vec<_> = groups
        .into_iter()
        .map(|((cx, cy), items)| {
            let sides: BTreeSet<_> = items.iter().map(|p| p.side.as_str()).collect();
            let side_key = cluster_side_key(sides.contains("T"), sides.contains("CT"));
            let (sum_x, sum_y) = items
                .iter()
                .filter_map(|p| mode.point(p))
                .fold((0.0, 0.0), |(sx, sy), (x, y)| (sx + x, sy + y));
            LandingCluster {
                id: format!("{cx}:{cy}"),
                x: sum_x / items.len() as f64,
                y: sum_y / items.len() as f64,
                count: items.len() as i64,
                first_grenade_id: items.iter().map(|p| p.id).min().unwrap_or(0),
                side_key: side_key.to_string(),
                unique_types: items
                    .iter()
                    .map(|p| p.grenade_type.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
                radar_level: cluster_radar_level.clone(),
            }
        })
        .collect();
    clusters.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.id.cmp(&b.id)));
    Ok(MapOverview {
        map: summary,
        grenade_count: list.total,
        clusters,
        type_counts,
        side_counts,
    })
}

#[tauri::command]
pub(super) fn get_favorite_map_overview(
    map: String,
    filters: FavoriteFilters,
    mode: FavoriteMapMode,
    state: tauri::State<'_, AppState>,
) -> AppResult<MapOverview> {
    favorite_overview_from_conn(&open_conn(&state)?, &state.radars, map, filters, mode)
}

fn favorite_cluster_from_conn(
    conn: &Connection,
    radars: &HashMap<String, RadarParams>,
    mut filters: FavoriteFilters,
    mode: FavoriteMapMode,
    cluster_id: &str,
) -> AppResult<Vec<GrenadePreview>> {
    let cell = parse_cluster_id(cluster_id)?;
    let offset = filters.offset.unwrap_or(0) as usize;
    let limit = filters.limit.unwrap_or(30) as usize;
    filters.limit = Some(0);
    filters.offset = None;
    let list = list_with_radars(conn, radars, filters)?;
    Ok(list
        .items
        .into_iter()
        .map(|p| p.preview)
        .filter(|p| mode.cell(p) == Some(cell))
        .skip(if limit == 0 { 0 } else { offset })
        .take(if limit == 0 { usize::MAX } else { limit })
        .collect())
}

#[tauri::command]
pub(super) fn get_favorite_cluster_grenades(
    map: String,
    mut filters: FavoriteFilters,
    mode: FavoriteMapMode,
    cluster_id: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<GrenadePreview>> {
    filters.map = Some(map);
    favorite_cluster_from_conn(
        &open_conn(&state)?,
        &state.radars,
        filters,
        mode,
        &cluster_id,
    )
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
        let demo_metadata = snapshot_demo_metadata(&tx, &raw, id)?;
        let mut snapshot = Snapshot {
            detail,
            raw,
            demo_metadata,
        };
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
    map: Option<String>,
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
    let collections = conn.prepare("SELECT c.id, c.name, COUNT(cm.favorite_id), c.map FROM favorite_collections c LEFT JOIN favorite_collection_members cm ON cm.collection_id=c.id GROUP BY c.id ORDER BY c.id")?
        .query_map([], |row| Ok(FavoriteCollection { id: row.get(0)?, name: row.get(1)?, grenade_count: row.get(2)?, map: row.get(3)? }))?.collect::<Result<Vec<_>, _>>()?;
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
    map: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<i64> {
    let conn = open_conn(&state)?;
    conn.execute(
        "INSERT INTO favorite_collections(name, map) VALUES (?1, ?2)",
        params![collection_name(name)?, collection_map(map)?],
    )?;
    Ok(conn.last_insert_rowid())
}

fn collection_map(map: String) -> AppResult<String> {
    let map = map.trim();
    if map.is_empty() {
        return Err(AppError::Message("Collection map is required".into()));
    }
    Ok(map.to_string())
}

#[tauri::command]
pub(super) fn assign_favorite_collection_map(
    id: i64,
    map: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    assign_collection_map(&open_conn(&state)?, id, map, name)
}

fn assign_collection_map(conn: &Connection, id: i64, map: String, name: String) -> AppResult<()> {
    if conn.execute("UPDATE favorite_collections SET map=?1, name=?3 WHERE id=?2 AND map IS NULL AND NOT EXISTS (SELECT 1 FROM favorite_collection_members WHERE collection_id=?2)", params![collection_map(map)?, id, collection_name(name)?])? == 0 {
        return Err(AppError::Message("Only an empty legacy collection can be assigned a map".into()));
    }
    Ok(())
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
    let map = tx
        .query_row("SELECT map FROM favorites WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .ok_or_else(|| AppError::Message("Favorite not found".into()))?;
    let collection_ids = collection_ids.into_iter().collect::<BTreeSet<_>>();
    for collection in &collection_ids {
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM favorite_collections WHERE id=?1 AND map=?2)",
            params![collection, map],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(AppError::Message(
                "Collection must belong to the grenade's map".into(),
            ));
        }
    }
    tx.execute(
        "DELETE FROM favorite_collection_members WHERE favorite_id=?1",
        [id],
    )?;
    for collection in collection_ids {
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
            ..Default::default()
        }
    }

    #[test]
    fn legacy_collections_split_by_map_once_and_keep_empty_collections() {
        let fixture = Fixture::new();
        let (_, source) = fixture.import(1, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        let saved = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        conn.execute("INSERT INTO favorites(identity_key, snapshot_json, map, grenade_type, side, search_text, source_label, saved_at) SELECT 'other-map', snapshot_json, 'de_other', grenade_type, side, search_text, source_label, saved_at FROM favorites WHERE id=?1", [saved]).unwrap();
        let other = conn.last_insert_rowid();
        conn.execute_batch("DROP TABLE favorite_collection_members;
            DROP TABLE favorite_collections;
            CREATE TABLE favorite_collections(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
            CREATE TABLE favorite_collection_members(collection_id INTEGER NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE, favorite_id INTEGER NOT NULL REFERENCES favorites(id) ON DELETE CASCADE, PRIMARY KEY(collection_id, favorite_id));
            INSERT INTO favorite_collections(id, name) VALUES (1, 'Single'), (2, 'Mixed'), (3, 'Empty');").unwrap();
        conn.execute(
            "INSERT INTO favorite_collection_members VALUES (1, ?1), (2, ?1), (2, ?2)",
            params![saved, other],
        )
        .unwrap();
        init_schema(&conn).unwrap();
        let snapshot = || {
            conn.prepare("SELECT c.id, c.name, c.map, cm.favorite_id FROM favorite_collections c LEFT JOIN favorite_collection_members cm ON cm.collection_id=c.id ORDER BY c.id, cm.favorite_id").unwrap()
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<i64>>(3)?))).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap()
        };
        let before = snapshot();
        assert_eq!(before.len(), 4);
        assert!(before.contains(&(1, "Single".into(), Some("de_test".into()), Some(saved))));
        assert!(before.contains(&(3, "Empty".into(), None, None)));
        assert_eq!(
            before
                .iter()
                .filter(|(_, name, _, _)| name == "Mixed")
                .count(),
            2
        );
        assert_eq!(membership(&conn, saved).unwrap().len(), 2);
        assert_eq!(membership(&conn, other).unwrap().len(), 1);
        init_schema(&conn).unwrap();
        assert_eq!(snapshot(), before);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
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
            "INSERT INTO favorite_collections(id, name, map) VALUES (1, 'A', 'de_test'), (2, 'B', 'de_test'), (3, 'Other', 'de_other'), (4, 'Legacy', NULL)",
            [],
        )
        .unwrap();
        set_membership(&mut conn, id, vec![1, 2, 1]).unwrap();
        assert_eq!(membership(&conn, id).unwrap(), vec![1, 2]);
        assert!(set_membership(&mut conn, id, vec![2, 999]).is_err());
        assert_eq!(membership(&conn, id).unwrap(), vec![1, 2]);
        assert!(set_membership(&mut conn, id, vec![2, 3]).is_err());
        assert!(set_membership(&mut conn, id, vec![4]).is_err());
        assert_eq!(membership(&conn, id).unwrap(), vec![1, 2]);
        let maps = favorite_maps_from_conn(&conn, &fixture.state.radars).unwrap();
        assert_eq!(
            maps.iter()
                .find(|m| m.name == "de_test")
                .unwrap()
                .grenade_count,
            1
        );
        assert_eq!(
            maps.iter()
                .find(|m| m.name == "de_other")
                .unwrap()
                .grenade_count,
            0
        );
        assign_collection_map(&conn, 4, "de_test".into(), "Assigned".into()).unwrap();
        assert!(assign_collection_map(&conn, 4, "de_other".into(), "Changed".into()).is_err());
        assert!(collection_map(" ".into()).is_err());
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
            "INSERT INTO favorite_collections(id, name, map) VALUES (1, 'Practice', 'de_test'), (2, 'Empty', 'de_test')",
            [],
        )
        .unwrap();
        set_membership(&mut conn, id, vec![1]).unwrap();
        conn.execute("UPDATE grenades SET start_map_x=20, start_map_y=20, explode_map_x=40, explode_map_y=40", []).unwrap();
        conn.execute("INSERT INTO grenades(import_id, source_index, map, grenade_type, side, usage_count, start_map_x, start_map_y, explode_map_x, explode_map_y) VALUES (?1, 2, 'de_test', 'smoke', 'T', 99, 20, 20, 40, 40)", [active]).unwrap();
        let query = |conn: &Connection, side: &str, coord: &str| {
            let filters = MapFilters {
                favorites_only: Some(true),
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
        assert_eq!(query(&conn, "T", "start"), vec![matching]);
        assert_eq!(query(&conn, "T", "explode"), vec![matching]);
        assert!(query(&conn, "CT", "start").is_empty());
        delete_from_conn(&mut conn, &fixture.state, id).unwrap();
        assert!(query(&conn, "T", "start").is_empty());
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

    #[test]
    fn saved_map_and_filters_survive_all_imports_and_visibility_threshold() {
        let fixture = Fixture::new();
        let (first_import, source) = fixture.import(1, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        conn.execute("UPDATE grenades SET start_map_x=20, start_map_y=30, explode_map_x=50, explode_map_y=60 WHERE id=?1", [source]).unwrap();
        let saved = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        let (second_import, other) = fixture.import(1, false);
        let unpositioned = save_from_conn(&mut conn, &fixture.state, other).unwrap();
        conn.execute(
            "INSERT INTO favorite_collections(id, name, map) VALUES (1, 'Practice', 'de_test'), (2, 'Empty', 'de_test')",
            [],
        )
        .unwrap();
        set_membership(&mut conn, saved, vec![1]).unwrap();
        conn.execute("INSERT INTO app_meta(key, value) VALUES ('public_min_usage_count', '50') ON CONFLICT(key) DO UPDATE SET value='50'", []).unwrap();

        let overview = |conn: &Connection, collection_id, mode| {
            favorite_overview_from_conn(
                conn,
                &fixture.state.radars,
                "de_test".into(),
                FavoriteFilters {
                    collection_id,
                    ..Default::default()
                },
                mode,
            )
            .unwrap()
        };
        let before = overview(&conn, None, FavoriteMapMode::Landing);
        assert_eq!(before.grenade_count, 2);
        assert_eq!(before.clusters.len(), 1);
        assert_eq!(before.clusters[0].id, "1:2");
        assert_eq!(before.clusters[0].first_grenade_id, saved);
        assert_eq!(
            overview(&conn, Some(1), FavoriteMapMode::Throw).clusters[0].id,
            "2:3"
        );
        assert_eq!(
            overview(&conn, Some(2), FavoriteMapMode::Landing).grenade_count,
            0
        );
        let maps = favorite_maps_from_conn(&conn, &fixture.state.radars).unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].grenade_count, 2);

        delete_import_from_conn(&mut conn, first_import).unwrap();
        delete_import_from_conn(&mut conn, second_import).unwrap();
        assert!(active_import_id(&conn).unwrap().is_none());
        assert_eq!(
            overview(&conn, None, FavoriteMapMode::Landing).grenade_count,
            2
        );
        let cluster_filters = || FavoriteFilters {
            map: Some("de_test".into()),
            collection_id: Some(1),
            ..Default::default()
        };
        let cluster = favorite_cluster_from_conn(
            &conn,
            &fixture.state.radars,
            cluster_filters(),
            FavoriteMapMode::Landing,
            "1:2",
        )
        .unwrap();
        assert_eq!(cluster[0].id, saved);
        assert_eq!(cluster[0].favorite_id, Some(saved));
        assert!(favorite_cluster_from_conn(
            &conn,
            &fixture.state.radars,
            cluster_filters(),
            FavoriteMapMode::Throw,
            "bad"
        )
        .is_err());
        assert!(list_from_conn(&conn, filters())
            .unwrap()
            .items
            .iter()
            .any(|p| p.preview.id == unpositioned));

        let mut technique = cluster_filters();
        technique.jump = Some(JumpFilter::Jumping);
        technique.movement = Some(MovementFilter::Stationary);
        assert_eq!(list_from_conn(&conn, technique).unwrap().total, 1);
        let mut technique = cluster_filters();
        technique.jump = Some(JumpFilter::Grounded);
        assert_eq!(list_from_conn(&conn, technique).unwrap().total, 0);
        let mut technique = cluster_filters();
        technique.movement = Some(MovementFilter::Moving);
        assert_eq!(list_from_conn(&conn, technique).unwrap().total, 0);
        conn.execute("INSERT INTO spawn_points(map, side, pos_x, pos_y, pos_z, map_x, map_y) VALUES ('de_test', 'T', 1, 2, 3, 20, 30)", []).unwrap();
        let mut technique = cluster_filters();
        technique.is_insta = Some(true);
        assert_eq!(list_from_conn(&conn, technique).unwrap().total, 1);
    }

    #[test]
    fn saved_radar_levels_and_cluster_pagination_use_the_same_set() {
        let fixture = Fixture::new();
        let (_, source) = fixture.import(1, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        conn.execute("UPDATE grenades SET start_map_x=20, start_map_y=30, explode_map_x=50, explode_map_y=60 WHERE id=?1", [source]).unwrap();
        let saved = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        conn.execute(
            "UPDATE map_assets SET lower_map_image_path='lower.png' WHERE name='de_test'",
            [],
        )
        .unwrap();
        let radars = HashMap::from([(
            "de_test".into(),
            RadarParams {
                pos_x: 0.0,
                pos_y: 0.0,
                scale: 1.0,
                split_z: Some(10.0),
            },
        )]);
        for ordinal in 0..35 {
            conn.execute("INSERT INTO favorites(identity_key, snapshot_json, map, grenade_type, side, search_text, source_label, saved_at) SELECT ?1, snapshot_json, map, grenade_type, side, search_text, source_label, saved_at FROM favorites WHERE id=?2", params![format!("map-page-{ordinal}"), saved]).unwrap();
        }
        let query = |level: &str, limit, offset| FavoriteFilters {
            map: Some("de_test".into()),
            radar_level: Some(level.into()),
            limit,
            offset,
            ..Default::default()
        };
        assert_eq!(
            list_with_radars(&conn, &radars, query("default", None, None))
                .unwrap()
                .total,
            0
        );
        let lower = list_with_radars(&conn, &radars, query("lower", None, None)).unwrap();
        assert_eq!(lower.total, 36);
        assert_eq!(lower.items[0].preview.explode_radar_level, "lower");
        let overview = favorite_overview_from_conn(
            &conn,
            &radars,
            "de_test".into(),
            query("lower", None, None),
            FavoriteMapMode::Landing,
        )
        .unwrap();
        assert_eq!(overview.clusters[0].count, 36);
        assert_eq!(overview.clusters[0].radar_level, "lower");
        assert_eq!(
            favorite_cluster_from_conn(
                &conn,
                &radars,
                query("lower", Some(30), Some(30)),
                FavoriteMapMode::Landing,
                "1:2"
            )
            .unwrap()
            .len(),
            6
        );
        assert_eq!(
            favorite_cluster_from_conn(
                &conn,
                &radars,
                query("lower", Some(0), Some(30)),
                FavoriteMapMode::Landing,
                "1:2"
            )
            .unwrap()
            .len(),
            36
        );
    }

    #[test]
    fn all_saved_filters_and_options_use_durable_match_metadata() {
        let fixture = Fixture::new();
        let (import, source) = fixture.import(8, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        conn.execute("UPDATE grenades SET demo_filename='File_match_2026-10-01.dem', thrower='Bob', thrower_steamid64='111', thrower_team='Blue', start_map_x=20, start_map_y=30, explode_map_x=50, explode_map_y=60 WHERE id=?1", [source]).unwrap();
        conn.execute("UPDATE grenade_usage_events SET demo_filename='Usage_match_2026-10-02.dem', thrower='Alice', thrower_steamid64='222', thrower_team='100%' WHERE grenade_id=?1", [source]).unwrap();
        conn.execute("INSERT INTO demo_metadata(import_id, demo_filename, tournament, demo_date) VALUES (?1, 'File_match_2026-10-01.dem', 'Explicit Cup', '2026-10-01'), (?1, 'Usage_match_2026-10-02.dem', 'Event Cup', '2026-10-02')", [import]).unwrap();
        let saved = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        conn.execute(
            "INSERT INTO favorite_collections(id, name, map) VALUES (1, 'Practice', 'de_test'), (2, 'Empty', 'de_test')",
            [],
        )
        .unwrap();
        set_membership(&mut conn, saved, vec![1]).unwrap();
        delete_import_from_conn(&mut conn, import).unwrap();
        let scope = || FavoriteFilters {
            map: Some("de_test".into()),
            collection_id: Some(1),
            ..Default::default()
        };
        let options = filter_options_from_conn(&conn, scope()).unwrap();
        assert_eq!(options.players.len(), 2);
        assert_eq!(options.tournaments.len(), 2);
        assert!(options
            .tournaments
            .iter()
            .any(|t| t.name == "Explicit Cup" && t.start_date == "2026-10-01"));
        let mut scoped = scope();
        scoped.tournament = Some(vec!["Event Cup".into()]);
        let scoped_options = filter_options_from_conn(&conn, scoped).unwrap();
        assert_eq!(scoped_options.players.len(), 1);
        assert_eq!(scoped_options.players[0].steamid64, "222");
        let mut combined = scope();
        combined.thrower_team = Some(vec!["100%".into(), "Missing".into()]);
        combined.thrower_steamid64 = Some(vec!["222".into(), "Missing".into()]);
        combined.tournament = Some(vec!["Event Cup".into(), "Missing".into()]);
        combined.min_usage = Some(8);
        assert_eq!(list_from_conn(&conn, combined).unwrap().total, 1);
        let mut query = scope();
        query.min_usage = Some(9);
        assert_eq!(list_from_conn(&conn, query).unwrap().total, 0);
        let mut query = scope();
        query.thrower_team = Some(vec!["100_".into()]);
        assert_eq!(list_from_conn(&conn, query).unwrap().total, 0);
        let mut query = scope();
        query.thrower_steamid64 = Some(vec!["999".into()]);
        assert_eq!(list_from_conn(&conn, query).unwrap().total, 0);
        let mut query = scope();
        query.tournament = Some(vec!["Event Cup".into()]);
        let overview = favorite_overview_from_conn(
            &conn,
            &fixture.state.radars,
            "de_test".into(),
            query,
            FavoriteMapMode::Landing,
        )
        .unwrap();
        assert_eq!(overview.grenade_count, 1);
        assert_eq!(overview.clusters[0].first_grenade_id, saved);
        assert!(filter_options_from_conn(
            &conn,
            FavoriteFilters {
                collection_id: Some(2),
                ..scope()
            }
        )
        .unwrap()
        .players
        .is_empty());
    }

    #[test]
    fn old_snapshots_capture_available_metadata_or_infer_it_after_source_deletion() {
        let fixture = Fixture::new();
        let (import, source) = fixture.import(2, true);
        let mut conn = open_conn(&fixture.state).unwrap();
        conn.execute(
            "UPDATE grenades SET demo_filename='Filename_match_2026-10-01.dem' WHERE id=?1",
            [source],
        )
        .unwrap();
        conn.execute("INSERT INTO demo_metadata(import_id, demo_filename, tournament, demo_date) VALUES (?1, 'Filename_match_2026-10-01.dem', 'Explicit Name', '2026-10-01')", [import]).unwrap();
        let saved = save_from_conn(&mut conn, &fixture.state, source).unwrap();
        conn.execute("UPDATE favorites SET snapshot_json=json_remove(snapshot_json, '$.demo_metadata') WHERE id=?1", [saved]).unwrap();
        backfill_snapshot_metadata(&conn).unwrap();
        assert_eq!(
            filter_options_from_conn(&conn, filters())
                .unwrap()
                .tournaments[0]
                .name,
            "Explicit Name"
        );
        conn.execute("UPDATE favorites SET snapshot_json=json_remove(snapshot_json, '$.demo_metadata') WHERE id=?1", [saved]).unwrap();
        delete_import_from_conn(&mut conn, import).unwrap();
        backfill_snapshot_metadata(&conn).unwrap();
        backfill_snapshot_metadata(&conn).unwrap();
        assert_eq!(
            filter_options_from_conn(&conn, filters())
                .unwrap()
                .tournaments[0]
                .name,
            "Filename"
        );
    }
}
