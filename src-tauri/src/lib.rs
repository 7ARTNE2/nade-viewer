use chrono::{Duration, Utc};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    io::BufReader,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Manager};
use thiserror::Error;

const WORLD: f64 = 1024.0;
const GRENADE_PREVIEW_COLUMNS: &str = "g.id, g.map, g.side, g.grenade_type, g.is_core,
    g.throw_description, g.coordinates, g.thrower, g.airtime, g.usage_count,
    g.start_map_x, g.start_map_y, g.explode_map_x, g.explode_map_y, g.explode_pos_z,
    g.trajectory_preview_json";

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Regex(#[from] regex::Error),
}
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    resource_dir: PathBuf,
    import_status: Arc<Mutex<ImportStatus>>,
}

#[derive(Clone, Serialize)]
struct ImportStatus {
    running: bool,
    stage: String,
    current: u64,
    total: u64,
    message: String,
    error: Option<String>,
}

impl Default for ImportStatus {
    fn default() -> Self {
        Self {
            running: false,
            stage: "idle".to_string(),
            current: 0,
            total: 0,
            message: "Ready".to_string(),
            error: None,
        }
    }
}

#[derive(Clone, Serialize)]
struct ImportReport {
    import_id: i64,
    grenade_count: u64,
    map_count: u64,
    source_path: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum JsonImportReport {
    GrenadeIndex {
        import_id: i64,
        grenade_count: u64,
        map_count: u64,
        source_path: String,
    },
    CoreNades {
        import_id: i64,
        grenade_count: u64,
        map_count: u64,
        source_path: String,
    },
}

impl From<ImportReport> for JsonImportReport {
    fn from(report: ImportReport) -> Self {
        Self::GrenadeIndex {
            import_id: report.import_id,
            grenade_count: report.grenade_count,
            map_count: report.map_count,
            source_path: report.source_path,
        }
    }
}

impl JsonImportReport {
    fn core_nades(report: ImportReport) -> Self {
        Self::CoreNades {
            import_id: report.import_id,
            grenade_count: report.grenade_count,
            map_count: report.map_count,
            source_path: report.source_path,
        }
    }
}

#[derive(Serialize)]
struct ImportSummary {
    id: i64,
    source_path: String,
    kind: String,
    label: Option<String>,
    imported_at: String,
    parser_version: Option<i64>,
    parser_updated_at: Option<String>,
    grenade_count: i64,
    map_count: i64,
    is_active: bool,
}

#[derive(Deserialize, Default)]
struct MapFilters {
    grenade_type: Option<String>,
    side: Option<String>,
    search: Option<String>,
    min_usage: Option<i64>,
    radar_level: Option<String>,
    is_core: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct SiteSettings {
    public_min_usage_count: i64,
}

#[derive(Serialize)]
struct OnboardingState {
    completed: bool,
}

#[derive(Serialize, Deserialize)]
struct CoreNadesFile {
    version: i64,
    exported_at: String,
    grenades: Vec<CoreNadeRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CoreNadeRecord {
    source_index: Option<i64>,
    map: String,
    side: String,
    grenade_type: String,
    throw_description: Option<String>,
    coordinates: Option<String>,
    thrower: Option<String>,
    airtime: Option<f64>,
    usage_count: Option<i64>,
    usage_throwers: Option<Vec<String>>,
    demo_filename: Option<String>,
    throw_tick: Option<i64>,
    lineup_tick: Option<i64>,
    tickrate: Option<i64>,
    round_time_seconds: Option<f64>,
    start_pos_x: Option<f64>,
    start_pos_y: Option<f64>,
    start_pos_z: Option<f64>,
    explode_pos_x: Option<f64>,
    explode_pos_y: Option<f64>,
    explode_pos_z: Option<f64>,
    start_map_x: Option<f64>,
    start_map_y: Option<f64>,
    explode_map_x: Option<f64>,
    explode_map_y: Option<f64>,
    trajectory_preview: Option<Value>,
}

#[derive(Serialize)]
struct CoreNadesExportReport {
    path: String,
    grenade_count: i64,
}

#[derive(Clone, Serialize)]
struct MapSummary {
    name: String,
    label: String,
    grenade_count: i64,
    preview_image_path: Option<String>,
    map_image_path: Option<String>,
    lower_map_image_path: Option<String>,
    has_lower_radar: bool,
    radar_split_z: Option<f64>,
    radar_scale: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct ParserIndex {
    version: Option<i64>,
    updated_at: Option<String>,
    core_nades: Option<bool>,
    canonical_grenades: Vec<RawGrenade>,
}

#[derive(Serialize, Deserialize)]
struct RawGrenade {
    map: String,
    side: Option<String>,
    grenade_type: Option<String>,
    throw_description: Option<String>,
    usage_count: Option<i64>,
    usage_throwers: Option<Vec<String>>,
    coordinates: Option<String>,
    demo_filename: Option<String>,
    throw_tick: Option<i64>,
    lineup_tick: Option<i64>,
    tickrate: Option<i64>,
    round_time_seconds: Option<f64>,
    start_pos_x: Option<f64>,
    start_pos_y: Option<f64>,
    start_pos_z: Option<f64>,
    explode_pos_x: Option<f64>,
    explode_pos_y: Option<f64>,
    explode_pos_z: Option<f64>,
    trajectory: Option<Vec<Vec<f64>>>,
    thrower: Option<String>,
    airtime: Option<f64>,
}

#[derive(Serialize)]
struct MapOverview {
    map: MapSummary,
    grenade_count: i64,
    clusters: Vec<LandingCluster>,
    type_counts: BTreeMap<String, i64>,
    side_counts: BTreeMap<String, i64>,
}

#[derive(Serialize)]
struct LandingCluster {
    id: String,
    x: f64,
    y: f64,
    count: i64,
    first_grenade_id: i64,
    side_key: String,
    unique_types: Vec<String>,
    radar_level: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct GrenadePreview {
    id: i64,
    map: String,
    side: String,
    grenade_type: String,
    is_core: bool,
    throw_description: Option<String>,
    coordinates: Option<String>,
    thrower: Option<String>,
    airtime: Option<f64>,
    usage_count: i64,
    start_map_x: Option<f64>,
    start_map_y: Option<f64>,
    explode_map_x: Option<f64>,
    explode_map_y: Option<f64>,
    explode_pos_z: Option<f64>,
    explode_radar_level: String,
    trajectory_preview: Option<Value>,
}

#[derive(Serialize)]
struct ViewedGrenade {
    #[serde(flatten)]
    preview: GrenadePreview,
    viewed_at: String,
    view_count: i64,
}

#[derive(Serialize)]
struct GrenadeDetail {
    #[serde(flatten)]
    preview: GrenadePreview,
    usage_throwers: Vec<String>,
    demo_filename: Option<String>,
    throw_tick: Option<i64>,
    lineup_tick: Option<i64>,
    tickrate: Option<i64>,
    round_time_seconds: Option<f64>,
    start_pos_x: Option<f64>,
    start_pos_y: Option<f64>,
    start_pos_z: Option<f64>,
    explode_pos_x: Option<f64>,
    explode_pos_y: Option<f64>,
    explode_pos_z: Option<f64>,
    map_image_path: Option<String>,
    preview_image_path: Option<String>,
}

#[derive(Serialize)]
struct SpawnPoint {
    map: String,
    side: String,
    pos_x: f64,
    pos_y: f64,
    pos_z: f64,
    map_x: Option<f64>,
    map_y: Option<f64>,
    command: String,
}

#[derive(Clone)]
struct RadarParams {
    pos_x: f64,
    pos_y: f64,
    scale: f64,
    split_z: Option<f64>,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            select_import_file,
            import_json,
            get_import_status,
            list_imports,
            set_active_import,
            update_import_label,
            delete_import,
            get_active_import,
            get_maps,
            get_map_overview,
            get_throw_overview,
            get_cluster_grenades,
            get_throw_cluster_grenades,
            get_grenade,
            record_grenade_view,
            get_recently_viewed_grenades,
            set_grenade_core,
            export_core_nades,
            get_similar_grenades,
            get_spawn_points,
            get_site_settings,
            update_site_settings,
            get_onboarding_state,
            complete_onboarding,
            reset_onboarding,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nade Viewer");
}

fn init_state(app: &AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let app_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_dir)?;
    let resource_dir = resolve_resource_dir(app)?;
    let db_path = app_dir.join("nadeviewer.sqlite");
    let state = AppState {
        db_path,
        resource_dir,
        import_status: Arc::new(Mutex::new(ImportStatus::default())),
    };
    let conn = open_conn(&state)?;
    init_schema(&conn)?;
    seed_assets(&conn, &state.resource_dir)?;
    seed_spawn_points(&conn, &state.resource_dir)?;
    Ok(state)
}

fn resolve_resource_dir(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut candidates = Vec::new();
    let tauri_resource = app.path().resource_dir()?;
    candidates.push(tauri_resource.clone());
    candidates.push(tauri_resource.join("resources"));

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("resources"));
        candidates.push(cwd.join("src-tauri").join("resources"));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources"));
            candidates.push(dir.join("resources").join("resources"));
        }
    }

    for candidate in candidates {
        if candidate.join("maps").join("2d").exists()
            && candidate.join("radar_configs").exists()
            && candidate.join("spawn_points.json").exists()
        {
            return Ok(candidate);
        }
    }

    Ok(tauri_resource)
}

fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'grenade_index',
            label TEXT,
            imported_at TEXT NOT NULL,
            parser_version INTEGER,
            parser_updated_at TEXT,
            grenade_count INTEGER NOT NULL,
            map_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS map_assets (
            name TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            preview_image_path TEXT,
            map_image_path TEXT,
            lower_map_image_path TEXT
        );
        CREATE TABLE IF NOT EXISTS grenades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id INTEGER NOT NULL,
            source_index INTEGER NOT NULL,
            map TEXT NOT NULL,
            side TEXT NOT NULL,
            grenade_type TEXT NOT NULL,
            is_core INTEGER NOT NULL DEFAULT 0,
            throw_description TEXT,
            coordinates TEXT,
            thrower TEXT,
            airtime REAL,
            usage_count INTEGER NOT NULL DEFAULT 1,
            usage_throwers_json TEXT,
            demo_filename TEXT,
            throw_tick INTEGER,
            lineup_tick INTEGER,
            tickrate INTEGER,
            round_time_seconds REAL,
            start_pos_x REAL,
            start_pos_y REAL,
            start_pos_z REAL,
            explode_pos_x REAL,
            explode_pos_y REAL,
            explode_pos_z REAL,
            start_map_x REAL,
            start_map_y REAL,
            explode_map_x REAL,
            explode_map_y REAL,
            trajectory_preview_json TEXT,
            trajectory_json TEXT,
            FOREIGN KEY(import_id) REFERENCES imports(id)
        );
        CREATE TABLE IF NOT EXISTS spawn_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            map TEXT NOT NULL,
            side TEXT NOT NULL,
            pos_x REAL NOT NULL,
            pos_y REAL NOT NULL,
            pos_z REAL NOT NULL,
            map_x REAL,
            map_y REAL
        );
        CREATE TABLE IF NOT EXISTS grenade_view_history (
            grenade_id INTEGER PRIMARY KEY,
            viewed_at TEXT NOT NULL,
            view_count INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(grenade_id) REFERENCES grenades(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_grenades_filter ON grenades(import_id, map, grenade_type, side);
        CREATE INDEX IF NOT EXISTS idx_grenades_explode ON grenades(import_id, map, explode_map_x, explode_map_y);
        CREATE INDEX IF NOT EXISTS idx_grenades_map_usage ON grenades(import_id, map, usage_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_grenades_map_type_usage ON grenades(import_id, map, grenade_type, usage_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_grenades_map_side_usage ON grenades(import_id, map, side, usage_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_grenades_map_type_side_usage ON grenades(import_id, map, grenade_type, side, usage_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_grenades_cluster ON grenades(import_id, map, CAST(explode_map_x / 28 AS INTEGER), CAST(explode_map_y / 28 AS INTEGER), usage_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_grenades_cluster_type_side ON grenades(import_id, map, grenade_type, side, CAST(explode_map_x / 28 AS INTEGER), CAST(explode_map_y / 28 AS INTEGER), usage_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_grenades_start ON grenades(import_id, map, start_map_x, start_map_y);
        CREATE INDEX IF NOT EXISTS idx_grenades_usage ON grenades(import_id, usage_count);
        CREATE INDEX IF NOT EXISTS idx_grenades_similar ON grenades(import_id, map, grenade_type, usage_count DESC, explode_map_x, explode_map_y, id);
        CREATE INDEX IF NOT EXISTS idx_spawn_side ON spawn_points(map, side);
        CREATE INDEX IF NOT EXISTS idx_grenade_view_history_recent ON grenade_view_history(viewed_at DESC);
        "#,
    )?;
    let has_is_core = {
        let mut stmt = conn.prepare("PRAGMA table_info(grenades)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "is_core")
    };
    if !has_is_core {
        conn.execute(
            "ALTER TABLE grenades ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let has_trajectory_json = {
        let mut stmt = conn.prepare("PRAGMA table_info(grenades)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "trajectory_json")
    };
    if !has_trajectory_json {
        conn.execute("ALTER TABLE grenades ADD COLUMN trajectory_json TEXT", [])?;
    }
    let has_import_kind = {
        let mut stmt = conn.prepare("PRAGMA table_info(imports)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "kind")
    };
    if !has_import_kind {
        conn.execute(
            "ALTER TABLE imports ADD COLUMN kind TEXT NOT NULL DEFAULT 'grenade_index'",
            [],
        )?;
    }
    let has_import_label = {
        let mut stmt = conn.prepare("PRAGMA table_info(imports)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "label")
    };
    if !has_import_label {
        conn.execute("ALTER TABLE imports ADD COLUMN label TEXT", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_grenades_core ON grenades(import_id, map, is_core)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_grenades_core_usage ON grenades(import_id, map, is_core, usage_count DESC, id)",
        [],
    )?;
    conn.execute_batch("PRAGMA optimize")?;
    Ok(())
}

fn set_status(state: &AppState, stage: &str, current: u64, total: u64, message: &str) {
    if let Ok(mut status) = state.import_status.lock() {
        status.running = stage != "done" && stage != "error" && stage != "idle";
        status.stage = stage.to_string();
        status.current = current;
        status.total = total;
        status.message = message.to_string();
        if stage != "error" {
            status.error = None;
        }
    }
}

fn set_error(state: &AppState, message: &str) {
    if let Ok(mut status) = state.import_status.lock() {
        status.running = false;
        status.stage = "error".to_string();
        status.message = message.to_string();
        status.error = Some(message.to_string());
    }
}

fn resource_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn map_key_to_name(key: &str) -> String {
    match key.to_lowercase().trim_start_matches("de_") {
        "dust2" => "Dust2".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => key.to_string(),
            }
        }
    }
}

fn map_name_to_key(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.starts_with("de_") {
        lower
    } else {
        format!("de_{}", lower)
    }
}

fn asset_score(name: &str, key: &str, lower: bool) -> i32 {
    let mut score = 0;
    if name.contains(key) {
        score += 50;
    }
    if lower == name.contains("lower") {
        score += 20;
    }
    if name == format!("{}_radar_psd.png", key) || name == format!("{}_lower_radar_psd.png", key) {
        score += 100;
    }
    score - name.matches('_').count() as i32
}

fn seed_assets(conn: &Connection, resource_dir: &Path) -> AppResult<()> {
    let maps_2d = resource_dir.join("maps").join("2d");
    let previews = resource_dir.join("maps").join("preview");
    let mut map_files: HashMap<String, (Option<PathBuf>, Option<PathBuf>)> = HashMap::new();

    if maps_2d.exists() {
        for entry in fs::read_dir(&maps_2d)? {
            let path = entry?.path();
            let Some(file_name) = path.file_name().and_then(|x| x.to_str()) else {
                continue;
            };
            let Some(caps) = Regex::new(r"(de_[a-z0-9]+)")?.captures(file_name) else {
                continue;
            };
            let key = caps[1].to_string();
            let lower = file_name.contains("lower");
            let slot = map_files.entry(key.clone()).or_default();
            if lower {
                if slot.1.as_ref().map_or(true, |old| {
                    asset_score(file_name, &key, true)
                        > asset_score(
                            old.file_name().unwrap().to_str().unwrap_or_default(),
                            &key,
                            true,
                        )
                }) {
                    slot.1 = Some(path);
                }
            } else if slot.0.as_ref().map_or(true, |old| {
                asset_score(file_name, &key, false)
                    > asset_score(
                        old.file_name().unwrap().to_str().unwrap_or_default(),
                        &key,
                        false,
                    )
            }) {
                slot.0 = Some(path);
            }
        }
    }

    let mut preview_files: HashMap<String, PathBuf> = HashMap::new();
    if previews.exists() {
        for entry in fs::read_dir(&previews)? {
            let path = entry?.path();
            let Some(file_name) = path.file_name().and_then(|x| x.to_str()) else {
                continue;
            };
            let Some(caps) = Regex::new(r"(de_[a-z0-9]+)")?.captures(file_name) else {
                continue;
            };
            let key = caps[1].to_string();
            if preview_files.get(&key).map_or(true, |old| {
                asset_score(file_name, &key, false)
                    > asset_score(
                        old.file_name().unwrap().to_str().unwrap_or_default(),
                        &key,
                        false,
                    )
            }) {
                preview_files.insert(key, path);
            }
        }
    }

    let mut keys: Vec<String> = map_files
        .keys()
        .chain(preview_files.keys())
        .cloned()
        .collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        let name = map_key_to_name(&key);
        let label = name.clone();
        let (map_image, lower_image) = map_files.get(&key).cloned().unwrap_or_default();
        let preview = preview_files.get(&key).cloned();
        conn.execute(
            "INSERT INTO map_assets(name, label, preview_image_path, map_image_path, lower_map_image_path)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(name) DO UPDATE SET
               label=excluded.label,
               preview_image_path=excluded.preview_image_path,
               map_image_path=excluded.map_image_path,
               lower_map_image_path=excluded.lower_map_image_path",
            params![
                name,
                label,
                preview.map(|p| resource_string(&p)),
                map_image.map(|p| resource_string(&p)),
                lower_image.map(|p| resource_string(&p)),
            ],
        )?;
    }
    Ok(())
}

fn parse_radar_file(path: &Path) -> AppResult<Option<RadarParams>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)?;
    let read = |key: &str| -> Option<f64> {
        let re = Regex::new(&format!(r#""{}"\s+"([^"]+)""#, key)).ok()?;
        re.captures(&content)?.get(1)?.as_str().parse::<f64>().ok()
    };
    let read_lower_split = || -> Option<f64> {
        let block_re = Regex::new(r#""lower"\s*(?://[^\n]*)?\s*\{(?s:(.*?))\}"#).ok()?;
        let block = block_re.captures(&content)?.get(1)?.as_str();
        let split_re = Regex::new(r#""AltitudeMax"\s+"([^"]+)""#).ok()?;
        split_re
            .captures(block)?
            .get(1)?
            .as_str()
            .parse::<f64>()
            .ok()
    };
    Ok(Some(RadarParams {
        pos_x: read("pos_x").unwrap_or(0.0),
        pos_y: read("pos_y").unwrap_or(0.0),
        scale: read("scale").unwrap_or(5.0),
        split_z: read_lower_split(),
    }))
}

fn load_radars(resource_dir: &Path) -> AppResult<HashMap<String, RadarParams>> {
    let mut radars = HashMap::new();
    let radar_dir = resource_dir.join("radar_configs");
    if !radar_dir.exists() {
        return Ok(radars);
    }
    for entry in fs::read_dir(radar_dir)? {
        let path = entry?.path();
        let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
            continue;
        };
        if let Some(params) = parse_radar_file(&path)? {
            radars.insert(stem.to_string(), params);
        }
    }
    Ok(radars)
}

fn game_to_map_coords(game_x: f64, game_y: f64, radar: &RadarParams) -> (f64, f64) {
    (
        (game_x - radar.pos_x) / radar.scale,
        (radar.pos_y - game_y) / radar.scale,
    )
}

fn radar_split_for_map(radars: &HashMap<String, RadarParams>, map: &str) -> Option<f64> {
    radars.get(&map_name_to_key(map)).and_then(|r| r.split_z)
}

fn seed_spawn_points(conn: &Connection, resource_dir: &Path) -> AppResult<()> {
    conn.execute("DELETE FROM spawn_points", [])?;
    let path = resource_dir.join("spawn_points.json");
    if !path.exists() {
        return Ok(());
    }
    let radars = load_radars(resource_dir)?;
    let value: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let Some(obj) = value.as_object() else {
        return Ok(());
    };
    for (key, points) in obj {
        let radar = radars.get(key);
        let Some(arr) = points.as_array() else {
            continue;
        };
        for point in arr {
            let side = point.get("side").and_then(Value::as_str).unwrap_or("Any");
            let pos_x = point.get("pos_x").and_then(Value::as_f64).unwrap_or(0.0);
            let pos_y = point.get("pos_y").and_then(Value::as_f64).unwrap_or(0.0);
            let pos_z = point.get("pos_z").and_then(Value::as_f64).unwrap_or(0.0);
            let (map_x, map_y) = radar
                .map(|r| game_to_map_coords(pos_x, pos_y, r))
                .unwrap_or((f64::NAN, f64::NAN));
            conn.execute(
                "INSERT INTO spawn_points(map, side, pos_x, pos_y, pos_z, map_x, map_y) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    map_key_to_name(key),
                    side,
                    pos_x,
                    pos_y,
                    pos_z,
                    if map_x.is_nan() { None } else { Some(map_x) },
                    if map_y.is_nan() { None } else { Some(map_y) },
                ],
            )?;
        }
    }
    Ok(())
}

fn active_import_id(conn: &Connection) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT value FROM app_meta WHERE key='active_import_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.parse::<i64>().ok()))
}

fn active_grenade_import_id(conn: &Connection, grenade_id: i64) -> AppResult<i64> {
    active_import_id(conn)?.ok_or_else(|| AppError::Message("No active import".to_string()))?;
    conn.query_row(
        "SELECT g.import_id
             FROM grenades g
             JOIN app_meta m ON m.key='active_import_id' AND CAST(m.value AS INTEGER)=g.import_id
             WHERE g.id=?1",
        params![grenade_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::Message("Grenade not found".to_string()))
}

fn public_min_usage_count(conn: &Connection) -> AppResult<i64> {
    let value = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key='public_min_usage_count'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1)
        .clamp(1, 50);
    Ok(value)
}

fn onboarding_completed(conn: &Connection) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT value FROM app_meta WHERE key='onboarding_completed'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .as_deref()
        == Some("1"))
}

fn open_conn(state: &AppState) -> AppResult<Connection> {
    let conn = Connection::open(&state.db_path)?;
    configure_conn(&conn)?;
    Ok(conn)
}

fn configure_conn(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys=ON;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA temp_store=MEMORY;
        PRAGMA cache_size=-65536;
        PRAGMA mmap_size=268435456;
        ",
    )?;
    Ok(())
}

fn filter_sql(filters: &MapFilters, args: &mut Vec<Box<dyn rusqlite::ToSql>>) -> String {
    let mut parts = Vec::new();
    if let Some(t) = filters
        .grenade_type
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "all")
    {
        parts.push("grenade_type = ?".to_string());
        args.push(Box::new(t.to_string()));
    }
    if let Some(side) = filters
        .side
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "Any")
    {
        parts.push("side = ?".to_string());
        args.push(Box::new(side.to_string()));
    }
    if let Some(min_usage) = filters.min_usage.filter(|v| *v > 0) {
        parts.push("usage_count >= ?".to_string());
        args.push(Box::new(min_usage));
    }
    if filters.is_core.unwrap_or(false) {
        parts.push("is_core = 1".to_string());
    }
    if let Some(search) = filters
        .search
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        parts.push(
            "(LOWER(COALESCE(thrower, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(usage_throwers_json, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(coordinates, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(demo_filename, '')) LIKE ? ESCAPE '\\')".to_string(),
        );
        let pattern = format!("%{}%", escape_like_pattern(&search.to_lowercase()));
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" AND {}", parts.join(" AND "))
    }
}

fn escape_like_pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn visibility_sql(
    conn: &Connection,
    args: &mut Vec<Box<dyn rusqlite::ToSql>>,
) -> AppResult<String> {
    args.push(Box::new(public_min_usage_count(conn)?));
    Ok(" AND usage_count >= ?".to_string())
}

fn has_lower_radar(summary: &MapSummary) -> bool {
    summary.lower_map_image_path.is_some() && summary.radar_split_z.is_some()
}

fn classify_radar_level(
    explode_pos_z: Option<f64>,
    split_z: Option<f64>,
    has_lower: bool,
) -> String {
    match explode_pos_z {
        None => "unknown".to_string(),
        Some(z) if has_lower && split_z.is_some_and(|split| z <= split) => "lower".to_string(),
        Some(_) => "default".to_string(),
    }
}

fn radar_level_sql(
    level: Option<&str>,
    summary: &MapSummary,
    args: &mut Vec<Box<dyn rusqlite::ToSql>>,
) -> String {
    if !has_lower_radar(summary) {
        return String::new();
    }
    let Some(split_z) = summary.radar_split_z else {
        return String::new();
    };
    match level {
        Some("lower") => {
            args.push(Box::new(split_z));
            " AND explode_pos_z IS NOT NULL AND explode_pos_z <= ?".to_string()
        }
        Some("default") => {
            args.push(Box::new(split_z));
            " AND (explode_pos_z IS NULL OR explode_pos_z > ?)".to_string()
        }
        _ => String::new(),
    }
}

fn grenade_preview_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GrenadePreview> {
    let trajectory_json: Option<String> = row.get("trajectory_preview_json")?;
    let explode_pos_z: Option<f64> = row.get("explode_pos_z")?;
    let split_z: Option<f64> = row.get("radar_split_z").unwrap_or(None);
    let has_lower = row
        .get::<_, Option<i64>>("has_lower_radar")
        .unwrap_or(None)
        .unwrap_or(0)
        == 1;
    Ok(GrenadePreview {
        id: row.get("id")?,
        map: row.get("map")?,
        side: row.get("side")?,
        grenade_type: row.get("grenade_type")?,
        is_core: row.get::<_, i64>("is_core")? == 1,
        throw_description: row.get("throw_description")?,
        coordinates: row.get("coordinates")?,
        thrower: row.get("thrower")?,
        airtime: row.get("airtime")?,
        usage_count: row.get("usage_count")?,
        start_map_x: row.get("start_map_x")?,
        start_map_y: row.get("start_map_y")?,
        explode_map_x: row.get("explode_map_x")?,
        explode_map_y: row.get("explode_map_y")?,
        explode_pos_z,
        explode_radar_level: classify_radar_level(explode_pos_z, split_z, has_lower),
        trajectory_preview: trajectory_json.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

fn raw_grenade_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawGrenade> {
    let usage_throwers_json: Option<String> = row.get("usage_throwers_json")?;
    let trajectory_json: Option<String> = row.get("trajectory_json")?;
    Ok(RawGrenade {
        map: row.get("map")?,
        side: Some(row.get("side")?),
        grenade_type: Some(row.get("grenade_type")?),
        throw_description: row.get("throw_description")?,
        usage_count: row.get("usage_count")?,
        usage_throwers: usage_throwers_json.and_then(|s| serde_json::from_str(&s).ok()),
        coordinates: row.get("coordinates")?,
        demo_filename: row.get("demo_filename")?,
        throw_tick: row.get("throw_tick")?,
        lineup_tick: row.get("lineup_tick")?,
        tickrate: row.get("tickrate")?,
        round_time_seconds: row.get("round_time_seconds")?,
        start_pos_x: row.get("start_pos_x")?,
        start_pos_y: row.get("start_pos_y")?,
        start_pos_z: row.get("start_pos_z")?,
        explode_pos_x: row.get("explode_pos_x")?,
        explode_pos_y: row.get("explode_pos_y")?,
        explode_pos_z: row.get("explode_pos_z")?,
        trajectory: trajectory_json.and_then(|s| serde_json::from_str(&s).ok()),
        thrower: row.get("thrower")?,
        airtime: row.get("airtime")?,
    })
}

fn sample_trajectory(traj: &[Vec<f64>], radar: Option<&RadarParams>) -> Vec<[f64; 2]> {
    if traj.is_empty() {
        return Vec::new();
    }
    let max = 64usize;
    let step = (traj.len() / max).max(1);
    traj.iter()
        .step_by(step)
        .filter_map(|pt| {
            if pt.len() < 2 {
                return None;
            }
            let (x, y) = radar
                .map(|r| game_to_map_coords(pt[0], pt[1], r))
                .unwrap_or((pt[0], pt[1]));
            Some([x, y])
        })
        .collect()
}

#[tauri::command]
fn select_import_file() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Grenade JSON", &["json"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn import_json(
    path: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<JsonImportReport> {
    let state = state.inner().clone();
    if state
        .import_status
        .lock()
        .map(|s| s.running)
        .unwrap_or(false)
    {
        return Err(AppError::Message(
            "An import is already running".to_string(),
        ));
    }

    let import_path = path.clone();
    let import_state = state.clone();
    set_status(&state, "reading", 0, 0, "Reading JSON");
    let result = tauri::async_runtime::spawn_blocking(move || {
        let source_path = PathBuf::from(&import_path);
        if !source_path.exists() {
            return Err(AppError::Message(format!(
                "File not found: {}",
                import_path
            )));
        }

        let file = fs::File::open(&source_path)?;
        let value: Value = serde_json::from_reader(BufReader::new(file))?;
        if value.get("canonical_grenades").is_some() {
            return import_index_blocking(&import_state, &import_path).map(JsonImportReport::from);
        }
        if value.get("grenades").is_some() {
            return import_core_nades_snapshot_blocking(&import_state, &import_path)
                .map(JsonImportReport::core_nades);
        }

        Err(AppError::Message(
            "Unsupported JSON. Choose grenade_index.json or Core Nades JSON.".to_string(),
        ))
    })
    .await;

    match result {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(err)) => {
            set_error(&state, &err.to_string());
            Err(err)
        }
        Err(err) => {
            set_error(&state, &err.to_string());
            Err(AppError::Message(err.to_string()))
        }
    }
}

#[tauri::command]
fn get_import_status(state: tauri::State<'_, AppState>) -> ImportStatus {
    state
        .import_status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

fn import_index_blocking(state: &AppState, path: &str) -> AppResult<ImportReport> {
    let source_path = PathBuf::from(path);
    if !source_path.exists() {
        return Err(AppError::Message(format!("File not found: {}", path)));
    }
    let file = fs::File::open(&source_path)?;
    let index: ParserIndex = serde_json::from_reader(BufReader::new(file))?;
    let total = index.canonical_grenades.len() as u64;
    set_status(state, "preparing", 0, total, "Preparing local database");
    let is_core_snapshot = index.core_nades.unwrap_or(false);
    let import_kind = if is_core_snapshot {
        "core_nades"
    } else {
        "grenade_index"
    };

    let radars = load_radars(&state.resource_dir)?;
    let mut conn = open_conn(state)?;
    init_schema(&conn)?;
    seed_assets(&conn, &state.resource_dir)?;
    seed_spawn_points(&conn, &state.resource_dir)?;

    let imported_at = Utc::now().to_rfc3339();
    let unique_maps = index
        .canonical_grenades
        .iter()
        .map(|g| g.map.clone())
        .collect::<std::collections::HashSet<_>>();
    let map_count = unique_maps.len() as u64;

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO imports(source_path, kind, imported_at, parser_version, parser_updated_at, grenade_count, map_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            path,
            import_kind,
            imported_at,
            index.version,
            index.updated_at,
            total as i64,
            map_count as i64
        ],
    )?;
    let import_id = tx.last_insert_rowid();

    for map_name in &unique_maps {
        tx.execute(
            "INSERT INTO map_assets(name, label) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET label=excluded.label",
            params![map_name, map_name],
        )?;
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO grenades(
                import_id, source_index, map, side, grenade_type, is_core, throw_description, coordinates,
                thrower, airtime, usage_count, usage_throwers_json, demo_filename, throw_tick,
                lineup_tick, tickrate, round_time_seconds, start_pos_x, start_pos_y, start_pos_z,
                explode_pos_x, explode_pos_y, explode_pos_z, start_map_x, start_map_y,
                explode_map_x, explode_map_y, trajectory_preview_json, trajectory_json
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
            )",
        )?;

        for (idx, g) in index.canonical_grenades.iter().enumerate() {
            if idx % 500 == 0 {
                set_status(state, "importing", idx as u64, total, "Indexing grenades");
            }
            let key = map_name_to_key(&g.map);
            let radar = radars.get(&key);
            let (start_map_x, start_map_y) = match (g.start_pos_x, g.start_pos_y, radar) {
                (Some(x), Some(y), Some(r)) => {
                    let (mx, my) = game_to_map_coords(x, y, r);
                    (Some(mx), Some(my))
                }
                _ => (None, None),
            };
            let (explode_map_x, explode_map_y) = match (g.explode_pos_x, g.explode_pos_y, radar) {
                (Some(x), Some(y), Some(r)) => {
                    let (mx, my) = game_to_map_coords(x, y, r);
                    (Some(mx), Some(my))
                }
                _ => (None, None),
            };
            let trajectory_preview = g
                .trajectory
                .as_ref()
                .map(|traj| sample_trajectory(traj, radar))
                .filter(|traj| !traj.is_empty())
                .map(|traj| serde_json::to_string(&traj))
                .transpose()?;
            let trajectory_json = g
                .trajectory
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;

            stmt.execute(params![
                import_id,
                idx as i64,
                g.map,
                g.side.as_deref().unwrap_or("Any"),
                g.grenade_type.as_deref().unwrap_or("smoke"),
                if is_core_snapshot { 1 } else { 0 },
                g.throw_description,
                g.coordinates,
                g.thrower,
                g.airtime,
                g.usage_count.unwrap_or(1),
                serde_json::to_string(&g.usage_throwers.clone().unwrap_or_default())?,
                g.demo_filename,
                g.throw_tick,
                g.lineup_tick,
                g.tickrate,
                g.round_time_seconds,
                g.start_pos_x,
                g.start_pos_y,
                g.start_pos_z,
                g.explode_pos_x,
                g.explode_pos_y,
                g.explode_pos_z,
                start_map_x,
                start_map_y,
                explode_map_x,
                explode_map_y,
                trajectory_preview,
                trajectory_json,
            ])?;
        }
    }

    tx.execute(
        "INSERT INTO app_meta(key, value) VALUES ('active_import_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![import_id.to_string()],
    )?;
    tx.commit()?;
    set_status(state, "done", total, total, "Import complete");
    Ok(ImportReport {
        import_id,
        grenade_count: total,
        map_count,
        source_path: path.to_string(),
    })
}

#[tauri::command]
fn list_imports(state: tauri::State<'_, AppState>) -> AppResult<Vec<ImportSummary>> {
    let conn = open_conn(&state)?;
    let active = active_import_id(&conn)?;
    let mut stmt = conn.prepare("SELECT id, source_path, kind, label, imported_at, parser_version, parser_updated_at, grenade_count, map_count FROM imports ORDER BY id DESC")?;
    let rows = stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        Ok(ImportSummary {
            id,
            source_path: row.get(1)?,
            kind: row.get(2)?,
            label: row.get(3)?,
            imported_at: row.get(4)?,
            parser_version: row.get(5)?,
            parser_updated_at: row.get(6)?,
            grenade_count: row.get(7)?,
            map_count: row.get(8)?,
            is_active: active == Some(id),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
fn set_active_import(
    import_id: i64,
    state: tauri::State<'_, AppState>,
) -> AppResult<ImportSummary> {
    let conn = open_conn(&state)?;
    set_active_import_in_conn(&conn, import_id)
}

fn set_active_import_in_conn(conn: &Connection, import_id: i64) -> AppResult<ImportSummary> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT id FROM imports WHERE id=?1",
            params![import_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Message("Import not found".to_string()));
    }
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES ('active_import_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![import_id.to_string()],
    )?;
    get_active_import_from_conn(&conn)?
        .ok_or_else(|| AppError::Message("Active import not found".to_string()))
}

#[tauri::command]
fn update_import_label(
    import_id: i64,
    label: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<ImportSummary> {
    let conn = open_conn(&state)?;
    let trimmed = label.trim();
    let changed = if trimmed.is_empty() {
        conn.execute(
            "UPDATE imports SET label=NULL WHERE id=?1",
            params![import_id],
        )?
    } else {
        conn.execute(
            "UPDATE imports SET label=?1 WHERE id=?2",
            params![trimmed, import_id],
        )?
    };
    if changed == 0 {
        return Err(AppError::Message("Import not found".to_string()));
    }
    let active = active_import_id(&conn)?;
    get_import_summary_by_id(&conn, import_id, active == Some(import_id))
}

#[tauri::command]
fn delete_import(
    import_id: i64,
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<ImportSummary>> {
    let mut conn = open_conn(&state)?;
    let active = delete_import_from_conn(&mut conn, import_id)?;
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;")?;
    Ok(active)
}

fn delete_import_from_conn(
    conn: &mut Connection,
    import_id: i64,
) -> AppResult<Option<ImportSummary>> {
    let tx = conn.transaction()?;
    let exists: Option<i64> = tx
        .query_row(
            "SELECT id FROM imports WHERE id=?1",
            params![import_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Message("Import not found".to_string()));
    }

    let current_active = active_import_id(&tx)?;
    tx.execute(
        "DELETE FROM grenade_view_history WHERE grenade_id IN (SELECT id FROM grenades WHERE import_id=?1)",
        params![import_id],
    )?;
    tx.execute(
        "DELETE FROM grenades WHERE import_id=?1",
        params![import_id],
    )?;
    tx.execute("DELETE FROM imports WHERE id=?1", params![import_id])?;

    let next_active = if current_active == Some(import_id) {
        tx.query_row(
            "SELECT id FROM imports ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    } else {
        current_active
    };

    match next_active {
        Some(next_id) => {
            tx.execute(
                "INSERT INTO app_meta(key, value) VALUES ('active_import_id', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![next_id.to_string()],
            )?;
        }
        None => {
            tx.execute("DELETE FROM app_meta WHERE key='active_import_id'", [])?;
        }
    }

    tx.commit()?;
    get_active_import_from_conn(&conn)
}

#[tauri::command]
fn get_active_import(state: tauri::State<'_, AppState>) -> AppResult<Option<ImportSummary>> {
    let conn = open_conn(&state)?;
    get_active_import_from_conn(&conn)
}

fn get_active_import_from_conn(conn: &Connection) -> AppResult<Option<ImportSummary>> {
    let active = active_import_id(conn)?;
    let Some(id) = active else { return Ok(None) };
    get_import_summary_by_id(conn, id, true).map(Some)
}

fn get_import_summary_by_id(
    conn: &Connection,
    import_id: i64,
    is_active: bool,
) -> AppResult<ImportSummary> {
    Ok(conn
        .query_row(
            "SELECT id, source_path, kind, label, imported_at, parser_version, parser_updated_at, grenade_count, map_count FROM imports WHERE id=?1",
            params![import_id],
            |row| {
                Ok(ImportSummary {
                    id: row.get(0)?,
                    source_path: row.get(1)?,
                    kind: row.get(2)?,
                    label: row.get(3)?,
                    imported_at: row.get(4)?,
                    parser_version: row.get(5)?,
                    parser_updated_at: row.get(6)?,
                    grenade_count: row.get(7)?,
                    map_count: row.get(8)?,
                    is_active,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Message("Import not found".to_string()))?)
}

#[tauri::command]
fn get_maps(state: tauri::State<'_, AppState>) -> AppResult<Vec<MapSummary>> {
    let conn = open_conn(&state)?;
    let active = active_import_id(&conn)?;
    let radars = load_radars(&state.resource_dir)?;
    let mut stmt = conn.prepare(
        "SELECT a.name, a.label, a.preview_image_path, a.map_image_path, a.lower_map_image_path,
         COALESCE(g.count, 0) AS grenade_count
         FROM map_assets a
         LEFT JOIN (
           SELECT map, COUNT(*) AS count FROM grenades WHERE import_id = ?1 AND usage_count >= ?2 GROUP BY map
         ) g ON g.map = a.name
         ORDER BY grenade_count DESC, a.label ASC",
    )?;
    let rows = stmt.query_map(
        params![active.unwrap_or(-1), public_min_usage_count(&conn)?],
        |row| {
            let name: String = row.get(0)?;
            let lower_map_image_path: Option<String> = row.get(4)?;
            let radar_split_z = radar_split_for_map(&radars, &name);
            let radar_scale = radars.get(&map_name_to_key(&name)).map(|radar| radar.scale);
            let has_lower_radar = lower_map_image_path.is_some() && radar_split_z.is_some();
            Ok(MapSummary {
                name,
                label: row.get(1)?,
                preview_image_path: row.get(2)?,
                map_image_path: row.get(3)?,
                lower_map_image_path,
                grenade_count: row.get(5)?,
                has_lower_radar,
                radar_split_z,
                radar_scale,
            })
        },
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn map_summary(
    conn: &Connection,
    resource_dir: &Path,
    import_id: i64,
    map: &str,
) -> AppResult<MapSummary> {
    let radars = load_radars(resource_dir)?;
    let mut summary = conn.query_row(
        "SELECT a.name, a.label, a.preview_image_path, a.map_image_path, a.lower_map_image_path,
         (SELECT COUNT(*) FROM grenades WHERE import_id=?1 AND map=a.name AND usage_count >= ?3)
         FROM map_assets a WHERE a.name=?2",
        params![import_id, map, public_min_usage_count(conn)?],
        |row| {
            let name: String = row.get(0)?;
            Ok(MapSummary {
                name,
                label: row.get(1)?,
                preview_image_path: row.get(2)?,
                map_image_path: row.get(3)?,
                lower_map_image_path: row.get(4)?,
                grenade_count: row.get(5)?,
                has_lower_radar: false,
                radar_split_z: None,
                radar_scale: None,
            })
        },
    ).optional()?.unwrap_or(MapSummary {
        name: map.to_string(),
        label: map.to_string(),
        grenade_count: 0,
        preview_image_path: None,
        map_image_path: None,
        lower_map_image_path: None,
        has_lower_radar: false,
        radar_split_z: None,
        radar_scale: None,
    });
    summary.radar_split_z = radar_split_for_map(&radars, &summary.name);
    summary.radar_scale = radars
        .get(&map_name_to_key(&summary.name))
        .map(|radar| radar.scale);
    summary.has_lower_radar = has_lower_radar(&summary);
    Ok(summary)
}

#[tauri::command]
fn get_map_overview(
    map: String,
    filters: MapFilters,
    state: tauri::State<'_, AppState>,
) -> AppResult<MapOverview> {
    map_overview_by(map, filters, "explode", state)
}

#[tauri::command]
fn get_throw_overview(
    map: String,
    filters: MapFilters,
    state: tauri::State<'_, AppState>,
) -> AppResult<MapOverview> {
    map_overview_by(map, filters, "start", state)
}

/// Radar-space grid cell (in 0..1024 units) used to group grenades into
/// clusters. Throw origins sit very close together, so they use a tighter cell
/// than landing points to avoid lumping distinct stances into one marker.
fn cluster_cell_size(coord: &str) -> i64 {
    match coord {
        // Throw origins are clustered only when they almost exactly coincide,
        // so distinct stances stay as separate markers.
        "start" => 10,
        _ => 28,
    }
}

/// Builds a map overview where grenades are clustered by either their landing
/// point (`coord = "explode"`) or their throw origin (`coord = "start"`).
fn map_overview_by(
    map: String,
    filters: MapFilters,
    coord: &str,
    state: tauri::State<'_, AppState>,
) -> AppResult<MapOverview> {
    let x_col = format!("{coord}_map_x");
    let y_col = format!("{coord}_map_y");
    let cell = cluster_cell_size(coord);
    let conn = open_conn(&state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    let summary = map_summary(&conn, &state.resource_dir, import_id, &map)?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(import_id), Box::new(map.clone())];
    let visibility = visibility_sql(&conn, &mut args)?;
    let filter = filter_sql(&filters, &mut args);
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), &summary, &mut args);
    let params_ref = rusqlite::params_from_iter(args.iter().map(|b| &**b));

    let count_sql = format!(
        "SELECT COUNT(*) FROM grenades WHERE import_id=? AND map=?{}{}{}",
        visibility, filter, radar_filter
    );
    let grenade_count: i64 = conn.query_row(&count_sql, params_ref, |row| row.get(0))?;

    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(import_id), Box::new(map.clone())];
    let visibility = visibility_sql(&conn, &mut args)?;
    let filter = filter_sql(&filters, &mut args);
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), &summary, &mut args);
    let params_ref = rusqlite::params_from_iter(args.iter().map(|b| &**b));
    let cluster_sql = format!(
        "SELECT
           CAST({x_col} / {cell} AS INTEGER) AS cx,
           CAST({y_col} / {cell} AS INTEGER) AS cy,
           AVG({x_col}), AVG({y_col}), COUNT(*), MIN(id),
           GROUP_CONCAT(DISTINCT side), GROUP_CONCAT(DISTINCT grenade_type)
         FROM grenades
         WHERE import_id=? AND map=? AND {x_col} IS NOT NULL AND {y_col} IS NOT NULL {}{}{}
         GROUP BY cx, cy
         ORDER BY COUNT(*) DESC
         LIMIT 420",
        visibility, filter, radar_filter
    );
    let cluster_radar_level = if summary.has_lower_radar {
        filters
            .radar_level
            .as_deref()
            .unwrap_or("default")
            .to_string()
    } else {
        "default".to_string()
    };
    let mut stmt = conn.prepare(&cluster_sql)?;
    let clusters = stmt
        .query_map(params_ref, |row| {
            let cx: i64 = row.get(0)?;
            let cy: i64 = row.get(1)?;
            let sides: String = row.get(6)?;
            let types: String = row.get(7)?;
            let side_values = sides.split(',').collect::<Vec<_>>();
            let has_t = side_values.iter().any(|side| *side == "T");
            let has_ct = side_values.iter().any(|side| *side == "CT");
            let side_key = if has_t && has_ct {
                "MIX"
            } else if has_t {
                "T"
            } else if has_ct {
                "CT"
            } else {
                "NEUTRAL"
            };
            Ok(LandingCluster {
                id: format!("{}:{}", cx, cy),
                x: row.get(2)?,
                y: row.get(3)?,
                count: row.get(4)?,
                first_grenade_id: row.get(5)?,
                side_key: side_key.to_string(),
                unique_types: types.split(',').map(|s| s.to_string()).collect(),
                radar_level: cluster_radar_level.clone(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let type_counts = grouped_counts(&conn, import_id, &map, &summary, &filters, "grenade_type")?;
    let side_counts = grouped_counts(&conn, import_id, &map, &summary, &filters, "side")?;
    Ok(MapOverview {
        map: summary,
        grenade_count,
        clusters,
        type_counts,
        side_counts,
    })
}

fn grouped_counts(
    conn: &Connection,
    import_id: i64,
    map: &str,
    summary: &MapSummary,
    filters: &MapFilters,
    field: &str,
) -> AppResult<BTreeMap<String, i64>> {
    let mut args: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(import_id), Box::new(map.to_string())];
    let visibility = visibility_sql(conn, &mut args)?;
    let filter = filter_sql(filters, &mut args);
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), summary, &mut args);
    let sql = format!(
        "SELECT {field}, COUNT(*) FROM grenades WHERE import_id=? AND map=?{}{}{} GROUP BY {field}",
        visibility, filter, radar_filter
    );
    let params_ref = rusqlite::params_from_iter(args.iter().map(|b| &**b));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_ref, |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<Result<BTreeMap<_, _>, _>>()?)
}

#[tauri::command]
fn get_cluster_grenades(
    map: String,
    cluster_id: String,
    filters: MapFilters,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<GrenadePreview>> {
    cluster_grenades_by(map, cluster_id, filters, limit, offset, "explode", state)
}

#[tauri::command]
fn get_throw_cluster_grenades(
    map: String,
    cluster_id: String,
    filters: MapFilters,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<GrenadePreview>> {
    cluster_grenades_by(map, cluster_id, filters, limit, offset, "start", state)
}

/// Returns the grenades that belong to a cluster keyed by either the landing
/// point (`coord = "explode"`) or the throw origin (`coord = "start"`).
fn cluster_grenades_by(
    map: String,
    cluster_id: String,
    filters: MapFilters,
    limit: u32,
    offset: u32,
    coord: &str,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<GrenadePreview>> {
    let x_col = format!("{coord}_map_x");
    let y_col = format!("{coord}_map_y");
    let cell = cluster_cell_size(coord);
    let conn = open_conn(&state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    let summary = map_summary(&conn, &state.resource_dir, import_id, &map)?;
    let (cx, cy) = parse_cluster_id(&cluster_id)?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(import_id),
        Box::new(map),
        Box::new(cx),
        Box::new(cy),
    ];
    let visibility = visibility_sql(&conn, &mut args)?;
    let filter = filter_sql(&filters, &mut args);
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), &summary, &mut args);
    args.push(Box::new(limit.max(1) as i64));
    args.push(Box::new(offset as i64));
    let split_literal = summary
        .radar_split_z
        .map(|v| v.to_string())
        .unwrap_or_else(|| "NULL".to_string());
    let has_lower_literal = if summary.has_lower_radar { 1 } else { 0 };
    let sql = format!(
        "SELECT {GRENADE_PREVIEW_COLUMNS}, {split_literal} AS radar_split_z, {has_lower_literal} AS has_lower_radar FROM grenades g
         WHERE import_id=? AND map=? AND CAST({x_col} / {cell} AS INTEGER)=? AND CAST({y_col} / {cell} AS INTEGER)=?{}{}{}
         ORDER BY usage_count DESC, id ASC LIMIT ? OFFSET ?",
        visibility, filter, radar_filter
    );
    let params_ref = rusqlite::params_from_iter(args.iter().map(|b| &**b));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_ref, grenade_preview_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn parse_cluster_id(id: &str) -> AppResult<(i64, i64)> {
    let mut parts = id.split(':');
    let cx = parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| AppError::Message("Invalid cluster id".to_string()))?;
    let cy = parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| AppError::Message("Invalid cluster id".to_string()))?;
    if parts.next().is_some() {
        return Err(AppError::Message("Invalid cluster id".to_string()));
    }
    Ok((cx, cy))
}

#[tauri::command]
fn get_grenade(id: i64, state: tauri::State<'_, AppState>) -> AppResult<GrenadeDetail> {
    let conn = open_conn(&state)?;
    active_grenade_import_id(&conn, id)?;
    let radars = load_radars(&state.resource_dir)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {GRENADE_PREVIEW_COLUMNS}, g.usage_throwers_json, g.demo_filename,
                g.throw_tick, g.lineup_tick, g.tickrate, g.round_time_seconds,
                g.start_pos_x, g.start_pos_y, g.start_pos_z,
                g.explode_pos_x, g.explode_pos_y,
                a.map_image_path, a.lower_map_image_path, a.preview_image_path
         FROM grenades g
         LEFT JOIN map_assets a ON a.name=g.map
         WHERE g.id=?1 AND g.import_id=(
             SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='active_import_id'
         )"
    ))?;
    Ok(stmt.query_row(params![id], |row| {
        let mut preview = grenade_preview_from_row(row)?;
        let lower_map_image_path: Option<String> = row.get("lower_map_image_path")?;
        let split_z = radar_split_for_map(&radars, &preview.map);
        let has_lower = lower_map_image_path.is_some() && split_z.is_some();
        preview.explode_radar_level =
            classify_radar_level(preview.explode_pos_z, split_z, has_lower);
        let throwers_json: Option<String> = row.get("usage_throwers_json")?;
        let default_map_image_path: Option<String> = row.get("map_image_path")?;
        let map_image_path = if preview.explode_radar_level == "lower" {
            lower_map_image_path.or(default_map_image_path)
        } else {
            default_map_image_path
        };
        Ok(GrenadeDetail {
            preview,
            usage_throwers: throwers_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            demo_filename: row.get("demo_filename")?,
            throw_tick: row.get("throw_tick")?,
            lineup_tick: row.get("lineup_tick")?,
            tickrate: row.get("tickrate")?,
            round_time_seconds: row.get("round_time_seconds")?,
            start_pos_x: row.get("start_pos_x")?,
            start_pos_y: row.get("start_pos_y")?,
            start_pos_z: row.get("start_pos_z")?,
            explode_pos_x: row.get("explode_pos_x")?,
            explode_pos_y: row.get("explode_pos_y")?,
            explode_pos_z: row.get("explode_pos_z")?,
            map_image_path,
            preview_image_path: row.get("preview_image_path")?,
        })
    })?)
}

#[tauri::command]
fn record_grenade_view(id: i64, state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let conn = open_conn(&state)?;
    active_grenade_import_id(&conn, id)?;

    let now = Utc::now();
    let duplicate_window_start = now - Duration::seconds(5);
    let changed = conn.execute(
        "INSERT INTO grenade_view_history(grenade_id, viewed_at, view_count)
         SELECT g.id, ?2, 1 FROM grenades g
         WHERE g.id=?1 AND g.import_id=(
             SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='active_import_id'
         )
         ON CONFLICT(grenade_id) DO UPDATE SET
           viewed_at=excluded.viewed_at,
           view_count=CASE
             WHEN grenade_view_history.viewed_at >= ?3 THEN grenade_view_history.view_count
             ELSE grenade_view_history.view_count + 1
           END",
        params![id, now.to_rfc3339(), duplicate_window_start.to_rfc3339()],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Grenade not found".to_string()));
    }
    Ok(true)
}

#[tauri::command]
fn get_recently_viewed_grenades(
    limit: u32,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<ViewedGrenade>> {
    let conn = open_conn(&state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {GRENADE_PREVIEW_COLUMNS}, h.viewed_at, h.view_count
         FROM grenade_view_history h
         JOIN grenades g ON g.id=h.grenade_id
         WHERE g.import_id=?1
         ORDER BY h.viewed_at DESC
         LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![import_id, limit.clamp(1, 12) as i64], |row| {
        Ok(ViewedGrenade {
            preview: grenade_preview_from_row(row)?,
            viewed_at: row.get("viewed_at")?,
            view_count: row.get("view_count")?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
fn set_grenade_core(id: i64, is_core: bool, state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let conn = open_conn(&state)?;
    active_grenade_import_id(&conn, id)?;
    let changed = conn.execute(
        "UPDATE grenades SET is_core=?1
         WHERE id=?2 AND import_id=(
             SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='active_import_id'
         )",
        params![if is_core { 1 } else { 0 }, id],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Grenade not found".to_string()));
    }
    Ok(is_core)
}

#[tauri::command]
fn export_core_nades(
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<CoreNadesExportReport>> {
    let conn = open_conn(&state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Core Nades", &["json"])
        .set_file_name("core_nades.json")
        .save_file()
    else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT source_index, map, side, grenade_type, throw_description, coordinates,
            thrower, airtime, usage_count, usage_throwers_json, demo_filename, throw_tick,
            lineup_tick, tickrate, round_time_seconds, start_pos_x, start_pos_y, start_pos_z,
            explode_pos_x, explode_pos_y, explode_pos_z, trajectory_json
         FROM grenades
         WHERE import_id=?1 AND is_core=1
         ORDER BY map ASC, grenade_type ASC, usage_count DESC, id ASC",
    )?;
    let rows = stmt.query_map(params![import_id], raw_grenade_from_row)?;
    let canonical_grenades = rows.collect::<Result<Vec<_>, _>>()?;
    let file = ParserIndex {
        version: Some(1),
        updated_at: Some(Utc::now().to_rfc3339()),
        core_nades: Some(true),
        canonical_grenades,
    };
    let text = serde_json::to_string_pretty(&file)?;
    fs::write(&path, text)?;
    Ok(Some(CoreNadesExportReport {
        path: resource_string(&path),
        grenade_count: file.canonical_grenades.len() as i64,
    }))
}

fn import_core_nades_snapshot_blocking(state: &AppState, path: &str) -> AppResult<ImportReport> {
    let source_path = PathBuf::from(path);
    if !source_path.exists() {
        return Err(AppError::Message(format!("File not found: {}", path)));
    }
    let file = fs::File::open(&source_path)?;
    let core_file: CoreNadesFile = serde_json::from_reader(BufReader::new(file))?;
    let total = core_file.grenades.len() as u64;
    set_status(
        state,
        "preparing",
        0,
        total,
        "Preparing Core Nades snapshot",
    );

    let radars = load_radars(&state.resource_dir)?;
    let mut conn = open_conn(state)?;
    init_schema(&conn)?;
    seed_assets(&conn, &state.resource_dir)?;
    seed_spawn_points(&conn, &state.resource_dir)?;

    let imported_at = Utc::now().to_rfc3339();
    let unique_maps = core_file
        .grenades
        .iter()
        .map(|g| g.map.clone())
        .collect::<std::collections::HashSet<_>>();
    let map_count = unique_maps.len() as u64;

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO imports(source_path, kind, imported_at, parser_version, parser_updated_at, grenade_count, map_count)
         VALUES (?1, 'core_nades', ?2, ?3, ?4, ?5, ?6)",
        params![
            path,
            imported_at,
            core_file.version,
            core_file.exported_at,
            total as i64,
            map_count as i64
        ],
    )?;
    let import_id = tx.last_insert_rowid();

    for map_name in &unique_maps {
        tx.execute(
            "INSERT INTO map_assets(name, label) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET label=excluded.label",
            params![map_name, map_name],
        )?;
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO grenades(
                import_id, source_index, map, side, grenade_type, is_core, throw_description, coordinates,
                thrower, airtime, usage_count, usage_throwers_json, demo_filename, throw_tick,
                lineup_tick, tickrate, round_time_seconds, start_pos_x, start_pos_y, start_pos_z,
                explode_pos_x, explode_pos_y, explode_pos_z, start_map_x, start_map_y,
                explode_map_x, explode_map_y, trajectory_preview_json
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
            )",
        )?;

        for (idx, g) in core_file.grenades.iter().enumerate() {
            if idx % 500 == 0 {
                set_status(state, "importing", idx as u64, total, "Indexing Core Nades");
            }
            let key = map_name_to_key(&g.map);
            let radar = radars.get(&key);
            let (start_map_x, start_map_y) = match (g.start_pos_x, g.start_pos_y, radar) {
                (Some(x), Some(y), Some(r)) => {
                    let (mx, my) = game_to_map_coords(x, y, r);
                    (Some(mx), Some(my))
                }
                _ => (g.start_map_x, g.start_map_y),
            };
            let (explode_map_x, explode_map_y) = match (g.explode_pos_x, g.explode_pos_y, radar) {
                (Some(x), Some(y), Some(r)) => {
                    let (mx, my) = game_to_map_coords(x, y, r);
                    (Some(mx), Some(my))
                }
                _ => (g.explode_map_x, g.explode_map_y),
            };
            let trajectory_preview = g
                .trajectory_preview
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;

            stmt.execute(params![
                import_id,
                g.source_index.unwrap_or(idx as i64),
                g.map,
                g.side,
                g.grenade_type,
                g.throw_description,
                g.coordinates,
                g.thrower,
                g.airtime,
                g.usage_count.unwrap_or(1),
                serde_json::to_string(&g.usage_throwers.clone().unwrap_or_default())?,
                g.demo_filename,
                g.throw_tick,
                g.lineup_tick,
                g.tickrate,
                g.round_time_seconds,
                g.start_pos_x,
                g.start_pos_y,
                g.start_pos_z,
                g.explode_pos_x,
                g.explode_pos_y,
                g.explode_pos_z,
                start_map_x,
                start_map_y,
                explode_map_x,
                explode_map_y,
                trajectory_preview,
            ])?;
        }
    }

    tx.execute(
        "INSERT INTO app_meta(key, value) VALUES ('active_import_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![import_id.to_string()],
    )?;
    tx.commit()?;
    set_status(state, "done", total, total, "Core Nades snapshot imported");
    Ok(ImportReport {
        import_id,
        grenade_count: total,
        map_count,
        source_path: path.to_string(),
    })
}

#[tauri::command]
fn get_similar_grenades(
    id: i64,
    limit: u32,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<GrenadePreview>> {
    let conn = open_conn(&state)?;
    active_grenade_import_id(&conn, id)?;
    let base: Option<(i64, String, String, Option<f64>, Option<f64>)> = conn
        .query_row(
            "SELECT import_id, map, grenade_type, explode_map_x, explode_map_y
             FROM grenades
             WHERE id=?1 AND import_id=(
                 SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='active_import_id'
             )",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((import_id, map, grenade_type, x, y)) = base else {
        return Ok(Vec::new());
    };
    let summary = map_summary(&conn, &state.resource_dir, import_id, &map)?;
    let split_literal = summary
        .radar_split_z
        .map(|v| v.to_string())
        .unwrap_or_else(|| "NULL".to_string());
    let has_lower_literal = if summary.has_lower_radar { 1 } else { 0 };
    let mut stmt = conn.prepare(
        &format!("SELECT {GRENADE_PREVIEW_COLUMNS}, {split_literal} AS radar_split_z, {has_lower_literal} AS has_lower_radar,
         ((COALESCE(explode_map_x, 0)-?4)*(COALESCE(explode_map_x, 0)-?4) + (COALESCE(explode_map_y, 0)-?5)*(COALESCE(explode_map_y, 0)-?5)) AS dist
         FROM grenades g
         WHERE import_id=?1 AND map=?2 AND grenade_type=?3 AND id<>?6 AND usage_count >= ?8
         ORDER BY dist ASC, usage_count DESC LIMIT ?7"),
    )?;
    let rows = stmt.query_map(
        params![
            import_id,
            map,
            grenade_type,
            x.unwrap_or(WORLD / 2.0),
            y.unwrap_or(WORLD / 2.0),
            id,
            limit.min(24) as i64,
            public_min_usage_count(&conn)?
        ],
        grenade_preview_from_row,
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
fn get_site_settings(state: tauri::State<'_, AppState>) -> AppResult<SiteSettings> {
    let conn = open_conn(&state)?;
    Ok(SiteSettings {
        public_min_usage_count: public_min_usage_count(&conn)?,
    })
}

#[tauri::command]
fn update_site_settings(
    public_min_usage_count: i64,
    state: tauri::State<'_, AppState>,
) -> AppResult<SiteSettings> {
    let value = public_min_usage_count.clamp(1, 50);
    let conn = open_conn(&state)?;
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES ('public_min_usage_count', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![value.to_string()],
    )?;
    Ok(SiteSettings {
        public_min_usage_count: value,
    })
}

#[tauri::command]
fn get_onboarding_state(state: tauri::State<'_, AppState>) -> AppResult<OnboardingState> {
    let conn = open_conn(&state)?;
    Ok(OnboardingState {
        completed: onboarding_completed(&conn)?,
    })
}

#[tauri::command]
fn complete_onboarding(state: tauri::State<'_, AppState>) -> AppResult<OnboardingState> {
    let conn = open_conn(&state)?;
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES ('onboarding_completed', '1')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )?;
    Ok(OnboardingState { completed: true })
}

#[tauri::command]
fn reset_onboarding(state: tauri::State<'_, AppState>) -> AppResult<OnboardingState> {
    let conn = open_conn(&state)?;
    conn.execute("DELETE FROM app_meta WHERE key='onboarding_completed'", [])?;
    Ok(OnboardingState { completed: false })
}

#[tauri::command]
fn get_spawn_points(
    map: String,
    side: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<SpawnPoint>> {
    let conn = open_conn(&state)?;
    let mut sql =
        "SELECT map, side, pos_x, pos_y, pos_z, map_x, map_y FROM spawn_points WHERE map=?1"
            .to_string();
    let mut owned: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(map)];
    if side == "T" || side == "CT" {
        sql.push_str(" AND side=?2");
        owned.push(Box::new(side));
    }
    sql.push_str(" ORDER BY side, id");
    let params_ref = rusqlite::params_from_iter(owned.iter().map(|b| &**b));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_ref, |row| {
        let pos_x: f64 = row.get(2)?;
        let pos_y: f64 = row.get(3)?;
        let pos_z: f64 = row.get(4)?;
        Ok(SpawnPoint {
            map: row.get(0)?,
            side: row.get(1)?,
            pos_x,
            pos_y,
            pos_z,
            map_x: row.get(5)?,
            map_y: row.get(6)?,
            command: format!(
                "setpos {} {} {}",
                fmt_num(pos_x),
                fmt_num(pos_y),
                fmt_num(pos_z)
            ),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn fmt_num(value: f64) -> String {
    if (value.fract()).abs() < 0.000001 {
        format!("{}", value as i64)
    } else {
        let s = format!("{:.2}", value);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_import(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO imports(id, source_path, imported_at, grenade_count, map_count)
             VALUES (?1, ?2, 'now', 1, 1)",
            params![id, format!("import-{id}")],
        )
        .unwrap();
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn converts_game_coordinates_to_radar_space() {
        let radar = RadarParams {
            pos_x: -2476.0,
            pos_y: 3239.0,
            scale: 4.4,
            split_z: Some(-100.0),
        };

        assert_eq!(game_to_map_coords(-2476.0, 3239.0, &radar), (0.0, 0.0));
        let (x, y) = game_to_map_coords(1924.0, -1161.0, &radar);
        assert!((x - 1000.0).abs() < 1e-9);
        assert!((y - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn classifies_radar_levels_at_split_boundary() {
        assert_eq!(classify_radar_level(None, Some(0.0), true), "unknown");
        assert_eq!(classify_radar_level(Some(-1.0), Some(0.0), true), "lower");
        assert_eq!(classify_radar_level(Some(0.0), Some(0.0), true), "lower");
        assert_eq!(classify_radar_level(Some(1.0), Some(0.0), true), "default");
        assert_eq!(
            classify_radar_level(Some(-1.0), Some(0.0), false),
            "default"
        );
        assert_eq!(classify_radar_level(Some(-1.0), None, true), "default");
    }

    #[test]
    fn parses_radar_format_and_scopes_lower_altitude() {
        let path = std::env::temp_dir().join(format!(
            "nade-viewer-radar-{}-{}.txt",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::write(
            &path,
            r#"
                "pos_x" "-100.5"
                "pos_y" "200"
                "scale" "2.5"
                "AltitudeMax" "999"
                "lower" // split-level metadata
                {
                    "AltitudeMax" "-64.25"
                }
            "#,
        )
        .unwrap();

        let radar = parse_radar_file(&path).unwrap().unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(radar.pos_x, -100.5);
        assert_eq!(radar.pos_y, 200.0);
        assert_eq!(radar.scale, 2.5);
        assert_eq!(radar.split_z, Some(-64.25));
    }

    #[test]
    fn search_filter_treats_like_metacharacters_as_literals() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        insert_import(&conn, 1);
        conn.execute_batch(
            "INSERT INTO grenades(import_id, source_index, map, side, grenade_type, thrower)
             VALUES (1, 0, 'de_test', 'T', 'smoke', '100% real'),
                    (1, 1, 'de_test', 'T', 'smoke', '1000 real'),
                    (1, 2, 'de_test', 'T', 'smoke', 'under_score'),
                    (1, 3, 'de_test', 'T', 'smoke', 'underXscore'),
                    (1, 4, 'de_test', 'T', 'smoke', 'path\\name');",
        )
        .unwrap();

        for (search, expected_index) in [("%", 0), ("_", 2), (r"\", 4)] {
            let filters = MapFilters {
                search: Some(format!("  {search}  ")),
                ..Default::default()
            };
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            let sql = format!(
                "SELECT source_index FROM grenades WHERE 1=1{}",
                filter_sql(&filters, &mut args)
            );
            let found: i64 = conn
                .query_row(
                    &sql,
                    rusqlite::params_from_iter(args.iter().map(|arg| &**arg)),
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, expected_index, "search term {search:?}");
        }
    }

    #[test]
    fn migrates_legacy_schema_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE imports (
                id INTEGER PRIMARY KEY, source_path TEXT NOT NULL, imported_at TEXT NOT NULL,
                parser_version INTEGER, parser_updated_at TEXT, grenade_count INTEGER NOT NULL,
                map_count INTEGER NOT NULL
             );
             CREATE TABLE grenades (
                id INTEGER PRIMARY KEY, import_id INTEGER NOT NULL, source_index INTEGER NOT NULL,
                map TEXT NOT NULL, side TEXT NOT NULL, grenade_type TEXT NOT NULL,
                usage_count INTEGER NOT NULL DEFAULT 1,
                start_map_x REAL, start_map_y REAL, explode_map_x REAL, explode_map_y REAL
             );
             INSERT INTO imports VALUES (7, 'legacy', 'then', NULL, NULL, 1, 1);
             INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type)
             VALUES (9, 7, 0, 'de_test', 'T', 'smoke');",
        )
        .unwrap();

        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();

        let migrated: (String, Option<String>, i64, Option<String>) = conn
            .query_row(
                "SELECT i.kind, i.label, g.is_core, g.trajectory_json
                 FROM imports i JOIN grenades g ON g.import_id=i.id WHERE i.id=7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(migrated, ("grenade_index".into(), None, 0, None));
    }

    #[test]
    fn validates_cluster_ids_and_uses_distinct_grid_sizes() {
        assert_eq!(cluster_cell_size("start"), 10);
        assert_eq!(cluster_cell_size("explode"), 28);
        assert_eq!(parse_cluster_id("-2:17").unwrap(), (-2, 17));
        for invalid in ["", "1", "a:2", "1:2:3"] {
            assert_eq!(
                parse_cluster_id(invalid).unwrap_err().to_string(),
                "Invalid cluster id"
            );
        }
    }

    #[test]
    fn switching_and_deleting_imports_preserves_history_and_selects_fallback() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        for id in 1..=3 {
            insert_import(&conn, id);
            conn.execute(
                "INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type)
                 VALUES (?1, ?2, 0, 'de_test', 'T', 'smoke')",
                params![id * 10, id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO grenade_view_history(grenade_id, viewed_at) VALUES (?1, 'now')",
                params![id * 10],
            )
            .unwrap();
        }

        assert_eq!(set_active_import_in_conn(&conn, 2).unwrap().id, 2);
        assert_eq!(active_import_id(&conn).unwrap(), Some(2));
        assert_eq!(
            set_active_import_in_conn(&conn, 99)
                .err()
                .unwrap()
                .to_string(),
            "Import not found"
        );

        assert_eq!(
            delete_import_from_conn(&mut conn, 1).unwrap().unwrap().id,
            2
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_view_history"), 2);
        assert_eq!(
            delete_import_from_conn(&mut conn, 2).unwrap().unwrap().id,
            3
        );
        assert_eq!(active_import_id(&conn).unwrap(), Some(3));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_view_history"), 1);
        assert!(delete_import_from_conn(&mut conn, 3).unwrap().is_none());
        assert_eq!(active_import_id(&conn).unwrap(), None);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_view_history"), 0);
    }

    #[test]
    fn active_grenade_is_limited_to_active_import() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO imports(id, source_path, kind, imported_at, grenade_count, map_count)
             VALUES (1, 'one', 'grenade_index', 'now', 1, 1),
                    (2, 'two', 'grenade_index', 'now', 1, 1);
             INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type)
             VALUES (10, 1, 0, 'de_dust2', 'T', 'smoke'),
                    (20, 2, 0, 'de_dust2', 'T', 'smoke');
             INSERT INTO app_meta(key, value) VALUES ('active_import_id', '1');",
        )
        .unwrap();

        assert_eq!(active_grenade_import_id(&conn, 10).unwrap(), 1);
        assert_eq!(
            active_grenade_import_id(&conn, 20).unwrap_err().to_string(),
            "Grenade not found"
        );

        conn.execute(
            "UPDATE app_meta SET value='2' WHERE key='active_import_id'",
            [],
        )
        .unwrap();
        assert_eq!(active_grenade_import_id(&conn, 20).unwrap(), 2);
        assert_eq!(
            active_grenade_import_id(&conn, 10).unwrap_err().to_string(),
            "Grenade not found"
        );
    }

    #[test]
    fn active_grenade_requires_an_active_import() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        assert_eq!(
            active_grenade_import_id(&conn, 10).unwrap_err().to_string(),
            "No active import"
        );
    }
}
