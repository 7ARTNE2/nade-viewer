use chrono::{Duration, NaiveDate, Utc};
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::IgnoredAny, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env, fs,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Manager};
use thiserror::Error;
mod dedup;
mod parser_store;
mod plugin;

const WORLD: f64 = 1024.0;
const SUPPORTED_IMPORT_VERSION: i64 = 1;
const DEFAULT_LIBRARY_MANIFEST_URL: &str =
    "https://github.com/7ARTNE2/nade-viewer/releases/download/library/library-manifest.json";
const GRENADE_PREVIEW_COLUMNS: &str = "g.id, g.map, g.side, g.grenade_type, g.is_core,
    g.throw_keys, g.coordinates, g.thrower, g.thrower_steamid64, g.thrower_team, g.airtime, g.usage_count, g.round_time_seconds,
    g.start_map_x, g.start_map_y, g.explode_map_x, g.explode_map_y, g.explode_pos_z,
    g.trajectory_preview_json";

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("{message}")]
    Import { code: &'static str, message: String },
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
        match self {
            Self::Import { code, message } => {
                #[derive(Serialize)]
                struct ImportError<'a> {
                    code: &'a str,
                    message: &'a str,
                }

                ImportError { code, message }.serialize(serializer)
            }
            _ => serializer.serialize_str(&self.to_string()),
        }
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    resource_dir: PathBuf,
    radars: Arc<HashMap<String, RadarParams>>,
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

#[derive(Clone, Serialize, Deserialize)]
struct LibraryManifest {
    version: String,
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
struct LibraryUpdate {
    manifest: LibraryManifest,
    current_version: Option<String>,
}

#[derive(Deserialize, Default)]
struct ImportEnvelopeShape {
    version: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_present")]
    canonical_grenades: bool,
    #[serde(default, deserialize_with = "deserialize_present")]
    grenades: bool,
}

fn deserialize_present<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    IgnoredAny::deserialize(deserializer)?;
    Ok(true)
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
    ScreenshotArchive {
        import_id: i64,
        grenade_count: u64,
        map_count: u64,
        screenshot_count: u64,
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

    fn screenshot_archive(report: ImportReport, screenshot_count: u64) -> Self {
        Self::ScreenshotArchive {
            import_id: report.import_id,
            grenade_count: report.grenade_count,
            map_count: report.map_count,
            screenshot_count,
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
    thrower_team: Option<String>,
    thrower_steamid64: Option<String>,
    tournament: Option<String>,
    min_usage: Option<i64>,
    radar_level: Option<String>,
    is_core: Option<bool>,
    is_insta: Option<bool>,
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
    #[serde(default, deserialize_with = "deserialize_players")]
    players: Vec<RawPlayer>,
}

enum TypedImportFile {
    GrenadeIndex(ParserIndex),
    CoreNades(CoreNadesFile),
}

#[derive(Deserialize)]
struct ScreenshotArchiveFile {
    version: i64,
    exported_at: String,
    grenades: Vec<ScreenshotArchiveGrenade>,
}

#[derive(Deserialize)]
struct ScreenshotArchiveGrenade {
    #[serde(flatten)]
    grenade: RawGrenade,
    screenshots: ScreenshotArchivePaths,
}

#[derive(Deserialize)]
struct ScreenshotArchivePaths {
    normal: String,
    wide: String,
    wide_fov: i64,
}

#[derive(Clone, Serialize, Deserialize)]
struct CoreNadeRecord {
    source_index: Option<i64>,
    map: String,
    side: String,
    grenade_type: String,
    throw_keys: Option<String>,
    coordinates: Option<String>,
    thrower: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    thrower_steamid64: Option<String>,
    thrower_team: Option<String>,
    airtime: Option<f64>,
    usage_count: Option<i64>,
    usage_throwers: Option<Vec<String>>,
    demo_filename: Option<String>,
    throw_tick: Option<i64>,
    lineup_tick: Option<i64>,
    tickrate: Option<f64>,
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
    trajectory: Option<Vec<Vec<f64>>>,
    trajectory_preview: Option<Value>,
    #[serde(default)]
    usage_events: Vec<GrenadeUsageEvent>,
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
    #[serde(
        default,
        deserialize_with = "deserialize_players",
        skip_serializing_if = "Vec::is_empty"
    )]
    players: Vec<RawPlayer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    processed_demos: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
struct RawGrenade {
    source_index: Option<i64>,
    map: String,
    side: Option<String>,
    grenade_type: Option<String>,
    throw_keys: Option<String>,
    usage_count: Option<i64>,
    usage_throwers: Option<Vec<String>>,
    coordinates: Option<String>,
    demo_filename: Option<String>,
    throw_tick: Option<i64>,
    lineup_tick: Option<i64>,
    tickrate: Option<f64>,
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
    trajectory: Option<Vec<Vec<f64>>>,
    trajectory_preview: Option<Value>,
    thrower: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    thrower_steamid64: Option<String>,
    thrower_team: Option<String>,
    airtime: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    usage_events: Vec<GrenadeUsageEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tournament: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct GrenadeUsageEvent {
    demo_filename: Option<String>,
    #[serde(alias = "tick")]
    throw_tick: Option<i64>,
    #[serde(alias = "player", alias = "player_name")]
    thrower: Option<String>,
    #[serde(
        default,
        alias = "steamid64",
        deserialize_with = "deserialize_optional_string"
    )]
    thrower_steamid64: Option<String>,
    #[serde(alias = "team", alias = "team_name")]
    thrower_team: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct RawPlayer {
    #[serde(alias = "demo")]
    demo_filename: Option<String>,
    #[serde(
        default,
        alias = "steam_id",
        alias = "steamId64",
        deserialize_with = "deserialize_optional_string"
    )]
    steamid64: Option<String>,
    #[serde(rename = "name", alias = "player_name", alias = "player")]
    player_name: Option<String>,
    #[serde(alias = "team", alias = "thrower_team")]
    team_name: Option<String>,
    side: Option<String>,
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(nonempty(value)),
        Some(Value::Number(value)) => Ok(Some(value.to_string())),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected a string or number, got {other}"
        ))),
    }
}

fn deserialize_players<'de, D>(deserializer: D) -> Result<Vec<RawPlayer>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let mut players = Vec::new();
    collect_players(&value, None, None, None, None, &mut players);
    Ok(players)
}

fn collect_players(
    value: &Value,
    demo_hint: Option<&str>,
    steamid_hint: Option<&str>,
    team_hint: Option<&str>,
    side_hint: Option<&str>,
    players: &mut Vec<RawPlayer>,
) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_players(
                    value,
                    demo_hint,
                    steamid_hint,
                    team_hint,
                    side_hint,
                    players,
                );
            }
        }
        Value::Object(object) => {
            let is_player = [
                "steamid64",
                "steam_id",
                "steamId64",
                "player_name",
                "player",
                "name",
                "team_name",
                "team",
                "side",
            ]
            .iter()
            .any(|key| object.contains_key(*key));
            if is_player {
                if let Ok(mut player) = serde_json::from_value::<RawPlayer>(value.clone()) {
                    if player.demo_filename.is_none() {
                        player.demo_filename = demo_hint.map(str::to_string);
                    }
                    if player.steamid64.is_none() {
                        player.steamid64 = steamid_hint.map(str::to_string);
                    }
                    if player.team_name.is_none() {
                        player.team_name = team_hint.map(str::to_string);
                    }
                    if player.side.is_none() {
                        player.side = side_hint.map(str::to_string);
                    }
                    players.push(player);
                }
                return;
            }

            let object_demo = object
                .get("demo_filename")
                .or_else(|| object.get("filename"))
                .or_else(|| object.get("demo"))
                .and_then(Value::as_str)
                .or(demo_hint);
            let object_team = object
                .get("team_name")
                .or_else(|| object.get("team"))
                .and_then(Value::as_str)
                .or(team_hint);
            let object_side = object.get("side").and_then(Value::as_str).or(side_hint);
            for (key, nested) in object {
                let nested_demo = if looks_like_demo_filename(key) {
                    Some(key.as_str())
                } else {
                    object_demo
                };
                let nested_steamid = if key.chars().all(|character| character.is_ascii_digit()) {
                    Some(key.as_str())
                } else {
                    steamid_hint
                };
                let nested_team = if key.eq_ignore_ascii_case("t")
                    || key.eq_ignore_ascii_case("ct")
                    || key.to_lowercase().contains("team")
                {
                    Some(key.as_str())
                } else {
                    object_team
                };
                collect_players(
                    nested,
                    nested_demo,
                    nested_steamid,
                    nested_team,
                    object_side,
                    players,
                );
            }
        }
        _ => {}
    }
}

fn nonempty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
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
    throw_keys: Option<String>,
    coordinates: Option<String>,
    thrower: Option<String>,
    thrower_steamid64: Option<String>,
    thrower_team: Option<String>,
    airtime: Option<f64>,
    usage_count: i64,
    round_time_seconds: Option<f64>,
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
    screenshot_image_path: Option<String>,
    screenshot_wide_image_path: Option<String>,
    usage_stats: GrenadeUsageStats,
}

#[derive(Clone, Default, Serialize)]
struct GrenadeUsageStats {
    tracked_throws: i64,
    peak: i64,
    most_used_player: Option<String>,
    most_used_player_throws: i64,
    most_used_team: Option<String>,
    most_used_team_throws: i64,
    last_demo: Option<String>,
    last_tick: Option<i64>,
    history: Vec<GrenadeUsageHistoryPoint>,
}

#[derive(Clone, Serialize)]
struct GrenadeUsageHistoryPoint {
    label: String,
    count: i64,
}

#[derive(Serialize)]
struct ImportTeam {
    team_name: String,
    player_count: i64,
}

#[derive(Clone, Serialize)]
struct ImportPlayer {
    steamid64: String,
    name: String,
    team_name: String,
    side: String,
}

#[derive(Serialize)]
struct ImportTournament {
    name: String,
    start_date: String,
    end_date: String,
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            app.manage(std::sync::Arc::new(std::sync::Mutex::new(
                crate::plugin::ParserStatus {
                    running: false,
                    stage: "idle".into(),
                    output: None,
                    error: None,
                    ..Default::default()
                },
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            select_import_file,
            import_json,
            plugin::install_nade_parser,
            plugin::uninstall_nade_parser,
            plugin::get_nade_parser_info,
            plugin::get_nade_parser_status,
            plugin::run_nade_parser,
            plugin::save_parser_output,
            plugin::select_demo_files,
            plugin::select_demo_folders,
            plugin::run_nade_parser_batch,
            plugin::deduplicate_parser_workspace,
            plugin::get_parser_workspace_counts,
            plugin::clear_parser_workspace,
            plugin::prepare_parser_import,
            check_library_update,
            import_library_update,
            get_import_status,
            list_imports,
            get_import_teams,
            get_import_players,
            get_import_tournaments,
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
    fs::create_dir_all(app_dir.join("screenshots"))?;
    let resource_dir = resolve_resource_dir(app)?;
    allow_asset_directories(app, &resource_dir, &app_dir)?;
    let db_path = app_dir.join("nadeviewer.sqlite");
    let radars = Arc::new(load_radars(&resource_dir)?);
    let state = AppState {
        db_path,
        resource_dir,
        radars,
        import_status: Arc::new(Mutex::new(ImportStatus::default())),
    };
    let conn = open_conn(&state)?;
    init_schema(&conn)?;
    seed_assets(&conn, &state.resource_dir)?;
    seed_spawn_points(&conn, &state.resource_dir)?;
    Ok(state)
}

fn asset_directories(resource_dir: &Path) -> [PathBuf; 2] {
    [
        resource_dir.join("maps").join("2d"),
        resource_dir.join("maps").join("preview"),
    ]
}

fn allow_asset_directories(
    app: &AppHandle,
    resource_dir: &Path,
    app_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    // Allow bundled maps and imported archive images without exposing the entire data directory.
    let scope = app.asset_protocol_scope();
    for directory in asset_directories(resource_dir) {
        scope.allow_directory(directory, true)?;
    }
    scope.allow_directory(app_dir.join("screenshots"), true)?;
    Ok(())
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
            throw_keys TEXT,
            coordinates TEXT,
            thrower TEXT,
            thrower_steamid64 TEXT,
            thrower_team TEXT,
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
            FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS grenade_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id INTEGER NOT NULL,
            grenade_id INTEGER NOT NULL,
            demo_filename TEXT,
            throw_tick INTEGER,
            thrower TEXT,
            thrower_steamid64 TEXT,
            thrower_team TEXT,
            FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE,
            FOREIGN KEY(grenade_id) REFERENCES grenades(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS import_players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id INTEGER NOT NULL,
            demo_filename TEXT,
            steamid64 TEXT,
            player_name TEXT,
            team_name TEXT,
            side TEXT,
            FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE,
            UNIQUE(import_id, demo_filename, steamid64, player_name, team_name, side)
        );
        CREATE TABLE IF NOT EXISTS demo_metadata (
            import_id INTEGER NOT NULL,
            demo_filename TEXT NOT NULL,
            tournament TEXT NOT NULL,
            demo_date TEXT NOT NULL,
            PRIMARY KEY(import_id, demo_filename),
            FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS import_map_players (
            import_id INTEGER NOT NULL,
            map TEXT NOT NULL,
            tournament TEXT NOT NULL DEFAULT '',
            steamid64 TEXT NOT NULL DEFAULT '',
            player_name TEXT NOT NULL DEFAULT '',
            team_name TEXT NOT NULL DEFAULT '',
            side TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(import_id, map, tournament, steamid64, player_name, team_name, side),
            FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
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
        CREATE TABLE IF NOT EXISTS grenade_screenshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id INTEGER NOT NULL,
            grenade_id INTEGER NOT NULL,
            image_path TEXT NOT NULL,
            wide_image_path TEXT NOT NULL,
            wide_fov INTEGER NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            wide_file_size INTEGER NOT NULL,
            captured_at TEXT NOT NULL,
            FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE,
            FOREIGN KEY(grenade_id) REFERENCES grenades(id) ON DELETE CASCADE,
            UNIQUE(import_id, grenade_id)
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
        CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_grenade ON grenade_usage_events(grenade_id, demo_filename, throw_tick);
        CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_import_demo ON grenade_usage_events(import_id, demo_filename);
        CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_player ON grenade_usage_events(import_id, thrower_steamid64);
        CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_team ON grenade_usage_events(import_id, thrower_team);
        CREATE INDEX IF NOT EXISTS idx_import_players_import_team ON import_players(import_id, team_name);
        CREATE INDEX IF NOT EXISTS idx_import_players_import_player ON import_players(import_id, steamid64);
        CREATE INDEX IF NOT EXISTS idx_import_players_import_demo ON import_players(import_id, demo_filename);
        CREATE INDEX IF NOT EXISTS idx_demo_metadata_tournament ON demo_metadata(import_id, tournament, demo_date);
        CREATE INDEX IF NOT EXISTS idx_demo_metadata_tournament_demo ON demo_metadata(import_id, tournament, demo_filename);
        CREATE INDEX IF NOT EXISTS idx_import_map_players_scope
            ON import_map_players(import_id, map, tournament, team_name, steamid64);
        CREATE INDEX IF NOT EXISTS idx_spawn_side ON spawn_points(map, side);
        CREATE INDEX IF NOT EXISTS idx_grenade_view_history_recent ON grenade_view_history(viewed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_grenade_screenshots_grenade ON grenade_screenshots(grenade_id);
        "#,
    )?;
    migrate_grenade_columns(conn)?;
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
    let has_thrower_team = {
        let mut stmt = conn.prepare("PRAGMA table_info(grenades)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "thrower_team")
    };
    if !has_thrower_team {
        conn.execute("ALTER TABLE grenades ADD COLUMN thrower_team TEXT", [])?;
    }
    let has_demo_filename = {
        let mut stmt = conn.prepare("PRAGMA table_info(grenades)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "demo_filename")
    };
    if has_demo_filename {
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_grenades_import_demo_map ON grenades(import_id, demo_filename, map)",
            [],
        )?;
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_grenades_import_map_team
         ON grenades(import_id, map, thrower_team)",
        [],
    )?;
    let grenade_columns = table_columns(conn, "grenades")?;
    if grenade_columns.contains("thrower_steamid64") {
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_grenades_import_map_player
             ON grenades(import_id, map, thrower_steamid64)",
            [],
        )?;
    }
    if grenade_columns.contains("thrower_steamid64")
        && grenade_columns.contains("thrower_team")
        && grenade_columns.contains("thrower")
    {
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_grenades_import_map_thrower
             ON grenades(import_id, map, thrower_team, thrower_steamid64, thrower)",
            [],
        )?;
    }
    if grenade_columns.contains("thrower_steamid64")
        && grenade_columns.contains("thrower_team")
        && grenade_columns.contains("thrower")
        && grenade_columns.contains("demo_filename")
        && grenade_columns.contains("side")
    {
        let lookup_backfilled = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key='import_map_players_backfill'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .as_deref()
            == Some("1");
        if !lookup_backfilled {
            backfill_import_map_players(conn)?;
        }
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_grenade_team
             ON grenade_usage_events(grenade_id, thrower_team);
         CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_grenade_player
             ON grenade_usage_events(grenade_id, thrower_steamid64);
         CREATE INDEX IF NOT EXISTS idx_grenade_usage_events_grenade_thrower
             ON grenade_usage_events(grenade_id, thrower_team, thrower_steamid64, thrower);",
    )?;
    conn.execute_batch("PRAGMA optimize")?;
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> AppResult<HashSet<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(columns.collect::<Result<HashSet<_>, _>>()?)
}

fn migrate_grenade_columns(conn: &Connection) -> AppResult<()> {
    let columns = table_columns(conn, "grenades")?;
    let has_throw_keys = columns.contains("throw_keys");
    let has_throw_description = columns.contains("throw_description");
    let has_thrower_steamid64 = columns.contains("thrower_steamid64");
    if has_throw_keys && !has_throw_description && has_thrower_steamid64 {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    if !has_throw_keys {
        tx.execute("ALTER TABLE grenades ADD COLUMN throw_keys TEXT", [])?;
    }
    if has_throw_description {
        tx.execute(
            "UPDATE grenades SET throw_keys=COALESCE(throw_keys, throw_description)",
            [],
        )?;
    }
    if !has_thrower_steamid64 {
        tx.execute("ALTER TABLE grenades ADD COLUMN thrower_steamid64 TEXT", [])?;
    }
    tx.commit()?;
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

fn try_begin_import(status: &Mutex<ImportStatus>) -> AppResult<()> {
    let mut status = status.lock().map_err(|_| AppError::Import {
        code: "import_state_unavailable",
        message: "Import state is unavailable".to_string(),
    })?;
    if status.running {
        return Err(AppError::Import {
            code: "import_already_running",
            message: "An import is already running".to_string(),
        });
    }
    status.running = true;
    status.stage = "reading".to_string();
    status.current = 0;
    status.total = 0;
    status.message = "Reading import".to_string();
    status.error = None;
    Ok(())
}

fn parse_import(reader: impl Read) -> AppResult<TypedImportFile> {
    let value: Value = serde_json::from_reader(reader).map_err(|error| AppError::Import {
        code: "invalid_json",
        message: format!("Invalid JSON: {error}"),
    })?;
    parse_import_value(value)
}

fn parse_import_bytes(bytes: &[u8], messagepack: bool) -> AppResult<TypedImportFile> {
    if !messagepack {
        return parse_import(bytes);
    }
    let value: Value = rmp_serde::from_slice(bytes).map_err(|error| AppError::Import {
        code: "invalid_messagepack",
        message: format!("Invalid MessagePack: {error}"),
    })?;
    parse_import_value(value)
}

fn fetch_library_manifest() -> AppResult<LibraryManifest> {
    let manifest_url =
        option_env!("NADE_VIEWER_LIBRARY_MANIFEST_URL").unwrap_or(DEFAULT_LIBRARY_MANIFEST_URL);
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::Import {
            code: "library_manifest_unavailable",
            message: format!("Unable to create library update client: {error}"),
        })?
        .get(manifest_url)
        .send()
        .map_err(|error| AppError::Import {
            code: "library_manifest_unavailable",
            message: format!("Unable to download library manifest: {error}"),
        })?;
    if !response.status().is_success() {
        return Err(AppError::Import {
            code: "library_manifest_unavailable",
            message: format!("Library manifest returned HTTP {}", response.status()),
        });
    }
    let value: LibraryManifest = response.json().map_err(|error| AppError::Import {
        code: "library_manifest_unavailable",
        message: format!("Invalid library manifest: {error}"),
    })?;
    validate_library_manifest(&value)?;
    Ok(value)
}

fn validate_library_manifest(manifest: &LibraryManifest) -> AppResult<()> {
    if manifest.version.trim().is_empty()
        || manifest.size == 0
        || !manifest.url.starts_with("https://")
        || manifest.sha256.len() != 64
        || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Import {
            code: "library_update_invalid",
            message: "Library manifest has invalid version, URL, size, or SHA-256".to_string(),
        });
    }
    Ok(())
}

fn app_meta_value(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM app_meta WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?)
}

fn installed_library_version(state: &AppState) -> AppResult<Option<String>> {
    let conn = open_conn(state)?;
    let version = app_meta_value(&conn, "library_version")?;
    let import_id = app_meta_value(&conn, "library_import_id")?;
    let installed = import_id
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .map(|id| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM imports WHERE id=?1)",
                params![id],
                |row| row.get::<_, bool>(0),
            )
        })
        .transpose()?
        .unwrap_or(false);
    Ok(installed.then_some(version).flatten())
}

#[tauri::command]
async fn check_library_update(
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<LibraryUpdate>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = fetch_library_manifest()?;
        let current_version = installed_library_version(&state)?;
        if current_version.as_deref() == Some(manifest.version.as_str()) {
            Ok(None)
        } else {
            Ok(Some(LibraryUpdate {
                manifest,
                current_version,
            }))
        }
    })
    .await
    .map_err(|error| AppError::Message(format!("Library update check failed: {error}")))?
}

fn download_library_file(state: &AppState, manifest: &LibraryManifest) -> AppResult<PathBuf> {
    let directory = state.db_path.parent().ok_or_else(|| {
        AppError::Message("Application data directory is unavailable".to_string())
    })?;
    let destination = directory.join("library-update.msgpack.part");
    let _ = fs::remove_file(&destination);
    let response = Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(2 * 60 * 60))
        .build()
        .map_err(|error| AppError::Import {
            code: "library_download_failed",
            message: format!("Unable to create library download client: {error}"),
        })?
        .get(&manifest.url)
        .send()
        .map_err(|error| AppError::Import {
            code: "library_download_failed",
            message: format!("Unable to download library: {error}"),
        })?;
    if !response.status().is_success() {
        return Err(AppError::Import {
            code: "library_download_failed",
            message: format!("Library download returned HTTP {}", response.status()),
        });
    }

    let mut file = fs::File::create(&destination).map_err(|error| AppError::Import {
        code: "library_download_failed",
        message: format!("Unable to create temporary library file: {error}"),
    })?;
    let mut response = response;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded = 0_u64;
    set_status(
        state,
        "downloading",
        0,
        manifest.size,
        "Downloading online library",
    );
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| AppError::Import {
                code: "library_download_failed",
                message: format!("Unable to read library download: {error}"),
            })?;
        if read == 0 {
            break;
        }
        downloaded = downloaded.saturating_add(read as u64);
        if downloaded > manifest.size {
            return Err(AppError::Import {
                code: "library_size_mismatch",
                message: format!("Library is larger than manifest size {}", manifest.size),
            });
        }
        file.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        set_status(
            state,
            "downloading",
            downloaded,
            manifest.size,
            "Downloading online library",
        );
    }
    file.flush()?;
    if downloaded != manifest.size {
        return Err(AppError::Import {
            code: "library_size_mismatch",
            message: format!(
                "Library size is {downloaded} bytes; manifest expects {}",
                manifest.size
            ),
        });
    }
    let digest = format!("{:x}", hasher.finalize());
    if !digest.eq_ignore_ascii_case(&manifest.sha256) {
        return Err(AppError::Import {
            code: "library_hash_mismatch",
            message: "Library SHA-256 does not match the manifest".to_string(),
        });
    }
    Ok(destination)
}

fn import_typed_path_blocking(state: &AppState, path: &str) -> AppResult<JsonImportReport> {
    let source_path = PathBuf::from(path);
    if source_path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        let (report, screenshot_count) = import_screenshot_archive_blocking(state, path)?;
        return Ok(JsonImportReport::screenshot_archive(
            report,
            screenshot_count,
        ));
    }
    let imported = if is_messagepack_path(&source_path) {
        // Decode MessagePack directly into the typed envelope to avoid keeping
        // both a 600+ MB byte buffer and an intermediate JSON value in memory.
        parse_messagepack_file(&source_path)?
    } else {
        let file = fs::File::open(&source_path).map_err(|error| AppError::Import {
            code: "file_unavailable",
            message: format!("Cannot open import file '{path}': {error}"),
        })?;
        let bytes = read_import_bytes(file)?;
        parse_import_bytes(&bytes, false)?
    };
    match imported {
        TypedImportFile::GrenadeIndex(index) => {
            import_index_blocking(state, path, index, None).map(JsonImportReport::from)
        }
        TypedImportFile::CoreNades(core_file) => {
            import_core_nades_snapshot_blocking(state, path, core_file, None)
                .map(JsonImportReport::core_nades)
        }
    }
}

fn parse_messagepack_file(path: &Path) -> AppResult<TypedImportFile> {
    let shape_file = fs::File::open(path).map_err(|error| AppError::Import {
        code: "file_unavailable",
        message: format!("Cannot open downloaded library: {error}"),
    })?;
    let shape: ImportEnvelopeShape =
        rmp_serde::from_read(BufReader::new(shape_file)).map_err(|error| AppError::Import {
            code: "invalid_messagepack",
            message: format!("Invalid MessagePack: {error}"),
        })?;
    if shape.canonical_grenades && shape.grenades {
        return Err(AppError::Import {
            code: "ambiguous_format",
            message: "Import cannot contain both canonical_grenades and grenades at the top level"
                .to_string(),
        });
    }
    if !shape.canonical_grenades && !shape.grenades {
        return Err(AppError::Import {
            code: "unsupported_format",
            message: "Unsupported import format: expected canonical_grenades or grenades at the top level"
                .to_string(),
        });
    }
    let version = shape.version.as_ref().filter(|value| !value.is_null());
    if shape.grenades && version.is_none() {
        return Err(AppError::Import {
            code: "missing_version",
            message: "Core Nades import requires top-level version 1".to_string(),
        });
    }
    if let Some(version) = version {
        let Some(version) = version.as_i64() else {
            return Err(AppError::Import {
                code: "invalid_version",
                message: "Top-level version must be an integer".to_string(),
            });
        };
        if version != SUPPORTED_IMPORT_VERSION {
            return Err(AppError::Import {
                code: "unsupported_version",
                message: format!(
                    "Unsupported import version {version}; supported version is {SUPPORTED_IMPORT_VERSION}"
                ),
            });
        }
    }

    let file = fs::File::open(path)?;
    if shape.canonical_grenades {
        rmp_serde::from_read(BufReader::new(file))
            .map(TypedImportFile::GrenadeIndex)
            .map_err(|error| AppError::Import {
                code: "invalid_canonical_format",
                message: format!("Invalid grenade_index import: {error}"),
            })
    } else {
        rmp_serde::from_read(BufReader::new(file))
            .map(TypedImportFile::CoreNades)
            .map_err(|error| AppError::Import {
                code: "invalid_core_format",
                message: format!("Invalid Core Nades import: {error}"),
            })
    }
}

fn parse_import_value(value: Value) -> AppResult<TypedImportFile> {
    let object = value.as_object().ok_or_else(|| AppError::Import {
        code: "invalid_top_level",
        message: "The top-level import value must be an object".to_string(),
    })?;
    let has_canonical = object.contains_key("canonical_grenades");
    let has_core = object.contains_key("grenades");
    if has_canonical && has_core {
        return Err(AppError::Import {
            code: "ambiguous_format",
            message: "Import cannot contain both canonical_grenades and grenades at the top level"
                .to_string(),
        });
    }
    if !has_canonical && !has_core {
        return Err(AppError::Import {
            code: "unsupported_format",
            message: "Unsupported import format: expected canonical_grenades or grenades at the top level"
                .to_string(),
        });
    }

    let version = object.get("version").filter(|value| !value.is_null());
    if has_core && version.is_none() {
        return Err(AppError::Import {
            code: "missing_version",
            message: "Core Nades import requires top-level version 1".to_string(),
        });
    }
    if let Some(version) = version {
        let Some(version) = version.as_i64() else {
            return Err(AppError::Import {
                code: "invalid_version",
                message: "Top-level version must be an integer".to_string(),
            });
        };
        if version != SUPPORTED_IMPORT_VERSION {
            return Err(AppError::Import {
                code: "unsupported_version",
                message: format!(
                    "Unsupported import version {version}; supported version is {SUPPORTED_IMPORT_VERSION}"
                ),
            });
        }
    }

    if has_canonical {
        serde_json::from_value::<ParserIndex>(value)
            .map(TypedImportFile::GrenadeIndex)
            .map_err(|error| AppError::Import {
                code: "invalid_canonical_format",
                message: format!("Invalid grenade_index import: {error}"),
            })
    } else {
        serde_json::from_value::<CoreNadesFile>(value)
            .map(TypedImportFile::CoreNades)
            .map_err(|error| AppError::Import {
                code: "invalid_core_format",
                message: format!("Invalid Core Nades import: {error}"),
            })
    }
}

fn read_import_bytes(file: fs::File) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    BufReader::new(file)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::Import {
            code: "file_unavailable",
            message: format!("Cannot read import file: {error}"),
        })?;
    Ok(bytes)
}

fn is_messagepack_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("messagepack")
                || extension.eq_ignore_ascii_case("msgpack")
                || extension.eq_ignore_ascii_case("mpk")
        })
}

fn round_tickrate(tickrate: Option<f64>) -> Option<i64> {
    let rounded = tickrate?.round();
    if !rounded.is_finite() || rounded < i64::MIN as f64 || rounded >= i64::MAX as f64 + 1.0 {
        None
    } else {
        Some(rounded as i64)
    }
}

fn demo_date_from_filename(filename: &str) -> Option<NaiveDate> {
    let filename = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .as_bytes();
    if filename.len() < 10 {
        return None;
    }

    let preferred = filename.len().checked_sub(14);
    preferred
        .into_iter()
        .chain(0..=filename.len() - 10)
        .filter_map(|start| std::str::from_utf8(filename.get(start..start + 10)?).ok())
        .find_map(|candidate| NaiveDate::parse_from_str(candidate, "%Y-%m-%d").ok())
}

fn demo_tournament_from_filename(filename: &str) -> Option<String> {
    let filename = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .trim();
    nonempty(filename.split_once('_')?.0.to_string())
}

fn looks_like_demo_filename(value: &str) -> bool {
    value.contains('_') && demo_date_from_filename(value).is_some()
}

fn record_demo_metadata(
    metadata: &mut BTreeMap<String, (String, String)>,
    filename: Option<&str>,
    tournament: Option<&str>,
) {
    let Some(filename) = filename.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let Some(date) = demo_date_from_filename(filename) else {
        return;
    };
    let explicit_tournament = tournament
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let parsed_tournament = explicit_tournament
        .clone()
        .or_else(|| demo_tournament_from_filename(filename));
    let Some(tournament) = parsed_tournament else {
        return;
    };

    match metadata.entry(filename.to_string()) {
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert((tournament, date.to_string()));
        }
        std::collections::btree_map::Entry::Occupied(mut entry) => {
            if explicit_tournament.is_some() {
                entry.insert((tournament, date.to_string()));
            }
        }
    }
}

fn collect_demo_metadata_from_value(
    value: &Value,
    metadata: &mut BTreeMap<String, (String, String)>,
) {
    match value {
        Value::String(filename) => record_demo_metadata(metadata, Some(filename), None),
        Value::Array(values) => {
            for value in values {
                collect_demo_metadata_from_value(value, metadata);
            }
        }
        Value::Object(object) => {
            let filename = object
                .get("demo_filename")
                .or_else(|| object.get("filename"))
                .and_then(Value::as_str);
            let tournament = object.get("tournament").and_then(Value::as_str);
            record_demo_metadata(metadata, filename, tournament);
            for (key, value) in object {
                if looks_like_demo_filename(key) {
                    record_demo_metadata(metadata, Some(key), tournament);
                }
                collect_demo_metadata_from_value(value, metadata);
            }
        }
        _ => {}
    }
}

fn insert_usage_event(
    conn: &Connection,
    import_id: i64,
    grenade_id: i64,
    event: &GrenadeUsageEvent,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO grenade_usage_events(
            import_id, grenade_id, demo_filename, throw_tick, thrower,
            thrower_steamid64, thrower_team
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            import_id,
            grenade_id,
            event.demo_filename.as_deref(),
            event.throw_tick,
            event.thrower.as_deref(),
            event.thrower_steamid64.as_deref(),
            event.thrower_team.as_deref(),
        ],
    )?;
    Ok(())
}

fn insert_import_player(conn: &Connection, import_id: i64, player: &RawPlayer) -> AppResult<()> {
    let demo_filename = player.demo_filename.as_deref().unwrap_or("").trim();
    let steamid64 = player.steamid64.as_deref().unwrap_or("").trim();
    let player_name = player.player_name.as_deref().unwrap_or("").trim();
    let team_name = player.team_name.as_deref().unwrap_or("").trim();
    let side = player.side.as_deref().unwrap_or("").trim();
    if steamid64.is_empty() && player_name.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO import_players(
            import_id, demo_filename, steamid64, player_name, team_name, side
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            import_id,
            demo_filename,
            steamid64,
            player_name,
            team_name,
            side,
        ],
    )?;
    Ok(())
}

fn insert_fallback_player(
    conn: &Connection,
    import_id: i64,
    demo_filename: Option<&str>,
    steamid64: Option<&str>,
    player_name: Option<&str>,
    team_name: Option<&str>,
    side: Option<&str>,
) -> AppResult<()> {
    insert_import_player(
        conn,
        import_id,
        &RawPlayer {
            demo_filename: demo_filename.map(str::to_string),
            steamid64: steamid64.map(str::to_string),
            player_name: player_name.map(str::to_string),
            team_name: team_name.map(str::to_string),
            side: side.map(str::to_string),
        },
    )
}

fn insert_demo_metadata(
    conn: &Connection,
    import_id: i64,
    metadata: &BTreeMap<String, (String, String)>,
) -> AppResult<()> {
    for (filename, (tournament, date)) in metadata {
        conn.execute(
            "INSERT INTO demo_metadata(import_id, demo_filename, tournament, demo_date)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(import_id, demo_filename) DO UPDATE SET
               tournament=excluded.tournament, demo_date=excluded.demo_date",
            params![import_id, filename, tournament, date],
        )?;
    }
    Ok(())
}

fn populate_import_map_players(conn: &Connection, import_id: i64) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO import_map_players(
             import_id, map, tournament, steamid64, player_name, team_name, side
         )
         SELECT g.import_id, g.map, COALESCE(dm.tournament, ''),
                COALESCE(g.thrower_steamid64, ''), COALESCE(g.thrower, ''),
                COALESCE(g.thrower_team, ''), COALESCE(g.side, '')
         FROM grenades g
         LEFT JOIN demo_metadata dm
           ON dm.import_id=g.import_id AND dm.demo_filename=g.demo_filename
         WHERE g.import_id=?1
           AND (g.thrower_steamid64 IS NOT NULL OR g.thrower IS NOT NULL)
           AND (g.thrower_steamid64 IS NOT NULL AND g.thrower_steamid64 <> '' OR g.thrower IS NOT NULL AND g.thrower <> '')
         UNION
         SELECT g.import_id, g.map, COALESCE(dm.tournament, ''),
                COALESCE(ue.thrower_steamid64, ''), COALESCE(ue.thrower, ''),
                COALESCE(ue.thrower_team, ''), COALESCE(g.side, '')
         FROM grenades g
         JOIN grenade_usage_events ue ON ue.grenade_id=g.id
         LEFT JOIN demo_metadata dm
           ON dm.import_id=ue.import_id AND dm.demo_filename=ue.demo_filename
         WHERE g.import_id=?1
           AND (ue.thrower_steamid64 IS NOT NULL OR ue.thrower IS NOT NULL)
           AND (ue.thrower_steamid64 IS NOT NULL AND ue.thrower_steamid64 <> '' OR ue.thrower IS NOT NULL AND ue.thrower <> '')",
        params![import_id],
    )?;
    Ok(())
}

fn backfill_import_map_players(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT id FROM imports ORDER BY id")?;
    let ids = stmt
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for import_id in ids {
        populate_import_map_players(conn, import_id)?;
    }
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES ('import_map_players_backfill', '1')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )?;
    Ok(())
}

fn collect_grenade_metadata(
    grenade: &RawGrenade,
    metadata: &mut BTreeMap<String, (String, String)>,
) {
    record_demo_metadata(
        metadata,
        grenade.demo_filename.as_deref(),
        grenade.tournament.as_deref(),
    );
    for event in &grenade.usage_events {
        record_demo_metadata(metadata, event.demo_filename.as_deref(), None);
    }
}

fn collect_player_metadata(player: &RawPlayer, metadata: &mut BTreeMap<String, (String, String)>) {
    record_demo_metadata(metadata, player.demo_filename.as_deref(), None);
}

fn add_canonical_fallback_players(
    conn: &Connection,
    import_id: i64,
    grenade: &RawGrenade,
) -> AppResult<()> {
    insert_fallback_player(
        conn,
        import_id,
        grenade.demo_filename.as_deref(),
        grenade.thrower_steamid64.as_deref(),
        grenade.thrower.as_deref(),
        grenade.thrower_team.as_deref(),
        grenade.side.as_deref(),
    )?;
    for event in &grenade.usage_events {
        insert_fallback_player(
            conn,
            import_id,
            event.demo_filename.as_deref(),
            event.thrower_steamid64.as_deref(),
            event.thrower.as_deref(),
            event.thrower_team.as_deref(),
            grenade.side.as_deref(),
        )?;
    }
    if let Some(throwers) = grenade.usage_throwers.as_deref() {
        for thrower in throwers {
            insert_fallback_player(
                conn,
                import_id,
                grenade.demo_filename.as_deref(),
                None,
                Some(thrower),
                grenade.thrower_team.as_deref(),
                grenade.side.as_deref(),
            )?;
        }
    }
    Ok(())
}

fn add_core_fallback_players(
    conn: &Connection,
    import_id: i64,
    grenade: &CoreNadeRecord,
) -> AppResult<()> {
    insert_fallback_player(
        conn,
        import_id,
        grenade.demo_filename.as_deref(),
        grenade.thrower_steamid64.as_deref(),
        grenade.thrower.as_deref(),
        grenade.thrower_team.as_deref(),
        Some(&grenade.side),
    )?;
    for event in &grenade.usage_events {
        insert_fallback_player(
            conn,
            import_id,
            event.demo_filename.as_deref(),
            event.thrower_steamid64.as_deref(),
            event.thrower.as_deref(),
            event.thrower_team.as_deref(),
            Some(&grenade.side),
        )?;
    }
    if let Some(throwers) = grenade.usage_throwers.as_deref() {
        for thrower in throwers {
            insert_fallback_player(
                conn,
                import_id,
                grenade.demo_filename.as_deref(),
                None,
                Some(thrower),
                grenade.thrower_team.as_deref(),
                Some(&grenade.side),
            )?;
        }
    }
    Ok(())
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
    let map_filename_re = Regex::new(r"(de_[a-z0-9]+)")?;

    if maps_2d.exists() {
        for entry in fs::read_dir(&maps_2d)? {
            let path = entry?.path();
            let Some(file_name) = path.file_name().and_then(|x| x.to_str()) else {
                continue;
            };
            let Some(caps) = map_filename_re.captures(file_name) else {
                continue;
            };
            let key = caps[1].to_string();
            let lower = file_name.contains("lower");
            let slot = map_files.entry(key.clone()).or_default();
            if lower {
                if slot.1.as_ref().is_none_or(|old| {
                    asset_score(file_name, &key, true)
                        > asset_score(
                            old.file_name().unwrap().to_str().unwrap_or_default(),
                            &key,
                            true,
                        )
                }) {
                    slot.1 = Some(path);
                }
            } else if slot.0.as_ref().is_none_or(|old| {
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
            let Some(caps) = map_filename_re.captures(file_name) else {
                continue;
            };
            let key = caps[1].to_string();
            if preview_files.get(&key).is_none_or(|old| {
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

fn filter_sql(
    filters: &MapFilters,
    args: &mut Vec<Box<dyn rusqlite::ToSql>>,
    alias: &str,
) -> String {
    let mut parts = Vec::new();
    if let Some(t) = filters
        .grenade_type
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "all")
    {
        if t == "molotov" {
            // Both team-specific fire grenades belong to the same filter.
            parts.push(format!(
                "{alias}.grenade_type IN ('molotov', 'incendiary grenade')"
            ));
        } else {
            parts.push(format!("{alias}.grenade_type = ?"));
            args.push(Box::new(t.to_string()));
        }
    }
    if let Some(side) = filters
        .side
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "Any")
    {
        parts.push(format!("{alias}.side = ?"));
        args.push(Box::new(side.to_string()));
    }
    if let Some(min_usage) = filters.min_usage.filter(|v| *v > 0) {
        parts.push(format!("{alias}.usage_count >= ?"));
        args.push(Box::new(min_usage));
    }
    if let Some(team) = filters
        .thrower_team
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        parts.push(format!(
            "(LOWER(COALESCE({alias}.thrower_team, '')) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM grenade_usage_events ue WHERE ue.grenade_id={alias}.id AND LOWER(COALESCE(ue.thrower_team, '')) LIKE ? ESCAPE '\\'))"
        ));
        args.push(Box::new(format!(
            "%{}%",
            escape_like_pattern(&team.to_lowercase())
        )));
        args.push(Box::new(format!(
            "%{}%",
            escape_like_pattern(&team.to_lowercase())
        )));
    }
    if let Some(steamid64) = filters
        .thrower_steamid64
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!(
            "({alias}.thrower_steamid64 = ? OR EXISTS (SELECT 1 FROM grenade_usage_events ue WHERE ue.grenade_id={alias}.id AND ue.thrower_steamid64 = ?))"
        ));
        args.push(Box::new(steamid64.to_string()));
        args.push(Box::new(steamid64.to_string()));
    }
    if let Some(tournament) = filters
        .tournament
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // Keyed by demo_filename on both sides so SQLite can use the
        // demo_metadata primary key instead of walking every demo in the
        // tournament for each candidate grenade.
        parts.push(format!(
            "(EXISTS (SELECT 1 FROM demo_metadata dm WHERE dm.import_id={alias}.import_id AND dm.demo_filename={alias}.demo_filename AND dm.tournament = ?) OR EXISTS (SELECT 1 FROM grenade_usage_events ue JOIN demo_metadata dm ON dm.import_id=ue.import_id AND dm.demo_filename=ue.demo_filename WHERE ue.grenade_id={alias}.id AND dm.tournament = ?))"
        ));
        args.push(Box::new(tournament.to_string()));
        args.push(Box::new(tournament.to_string()));
    }
    if filters.is_core.unwrap_or(false) {
        parts.push(format!("{alias}.is_core = 1"));
    }
    if filters.is_insta.unwrap_or(false) {
        parts.push(format!(
            "EXISTS (SELECT 1 FROM spawn_points sp WHERE sp.map={alias}.map AND sp.map_x IS NOT NULL AND sp.map_y IS NOT NULL AND ABS(sp.map_x - {alias}.start_map_x) <= 0.05 AND ABS(sp.map_y - {alias}.start_map_y) <= 0.05)"
        ));
    }
    if let Some(search) = filters
        .search
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        parts.push(
            format!(
                "(LOWER(COALESCE({alias}.thrower, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE({alias}.thrower_steamid64, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE({alias}.usage_throwers_json, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE({alias}.coordinates, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE({alias}.demo_filename, '')) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM grenade_usage_events ue WHERE ue.grenade_id={alias}.id AND (LOWER(COALESCE(ue.thrower, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(ue.thrower_steamid64, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(ue.thrower_team, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(ue.demo_filename, '')) LIKE ? ESCAPE '\\')))"
            ),
        );
        let pattern = format!("%{}%", escape_like_pattern(&search.to_lowercase()));
        for _ in 0..9 {
            args.push(Box::new(pattern.clone()));
        }
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
    alias: &str,
) -> AppResult<String> {
    args.push(Box::new(public_min_usage_count(conn)?));
    Ok(format!(" AND {alias}.usage_count >= ?"))
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
    alias: &str,
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
            format!(" AND {alias}.explode_pos_z IS NOT NULL AND {alias}.explode_pos_z <= ?")
        }
        Some("default") => {
            args.push(Box::new(split_z));
            format!(" AND ({alias}.explode_pos_z IS NULL OR {alias}.explode_pos_z > ?)")
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
        throw_keys: row.get("throw_keys")?,
        coordinates: row.get("coordinates")?,
        thrower: row.get("thrower")?,
        thrower_steamid64: row.get("thrower_steamid64")?,
        thrower_team: row.get("thrower_team")?,
        airtime: row.get("airtime")?,
        usage_count: row.get("usage_count")?,
        round_time_seconds: row.get("round_time_seconds")?,
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
    let trajectory_preview_json: Option<String> = row.get("trajectory_preview_json")?;
    Ok(RawGrenade {
        source_index: row.get("source_index")?,
        map: row.get("map")?,
        side: Some(row.get("side")?),
        grenade_type: Some(row.get("grenade_type")?),
        throw_keys: row.get("throw_keys")?,
        usage_count: row.get("usage_count")?,
        usage_throwers: usage_throwers_json.and_then(|s| serde_json::from_str(&s).ok()),
        coordinates: row.get("coordinates")?,
        demo_filename: row.get("demo_filename")?,
        throw_tick: row.get("throw_tick")?,
        lineup_tick: row.get("lineup_tick")?,
        tickrate: row
            .get::<_, Option<i64>>("tickrate")?
            .map(|tickrate| tickrate as f64),
        round_time_seconds: row.get("round_time_seconds")?,
        start_pos_x: row.get("start_pos_x")?,
        start_pos_y: row.get("start_pos_y")?,
        start_pos_z: row.get("start_pos_z")?,
        explode_pos_x: row.get("explode_pos_x")?,
        explode_pos_y: row.get("explode_pos_y")?,
        explode_pos_z: row.get("explode_pos_z")?,
        start_map_x: row.get("start_map_x")?,
        start_map_y: row.get("start_map_y")?,
        explode_map_x: row.get("explode_map_x")?,
        explode_map_y: row.get("explode_map_y")?,
        trajectory: trajectory_json.and_then(|s| serde_json::from_str(&s).ok()),
        trajectory_preview: trajectory_preview_json.and_then(|s| serde_json::from_str(&s).ok()),
        thrower: row.get("thrower")?,
        thrower_steamid64: row.get("thrower_steamid64")?,
        thrower_team: row.get("thrower_team")?,
        airtime: row.get("airtime")?,
        usage_events: Vec::new(),
        tournament: None,
    })
}

fn load_usage_events(conn: &Connection, grenade_id: i64) -> AppResult<Vec<GrenadeUsageEvent>> {
    let mut stmt = conn.prepare(
        "SELECT demo_filename, throw_tick, thrower, thrower_steamid64, thrower_team
         FROM grenade_usage_events WHERE grenade_id=?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![grenade_id], |row| {
        Ok(GrenadeUsageEvent {
            demo_filename: row.get(0)?,
            throw_tick: row.get(1)?,
            thrower: row.get(2)?,
            thrower_steamid64: row.get(3)?,
            thrower_team: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

struct UsageFallback<'a> {
    usage_count: i64,
    usage_throwers: &'a [String],
    thrower: Option<&'a str>,
    steamid64: Option<&'a str>,
    team: Option<&'a str>,
    demo: Option<&'a str>,
    tick: Option<i64>,
}

fn usage_stats_from_conn(
    conn: &Connection,
    grenade_id: i64,
    fallback: UsageFallback<'_>,
) -> AppResult<GrenadeUsageStats> {
    let events = load_usage_events(conn, grenade_id)?;
    if events.is_empty() {
        let tracked_throws = fallback.usage_count.max(0);
        let player = fallback
            .thrower
            .or_else(|| fallback.usage_throwers.first().map(String::as_str))
            .or(fallback.steamid64)
            .map(str::to_string);
        return Ok(GrenadeUsageStats {
            tracked_throws,
            peak: tracked_throws,
            most_used_player: player,
            most_used_player_throws: tracked_throws,
            most_used_team: fallback.team.map(str::to_string),
            most_used_team_throws: tracked_throws,
            last_demo: fallback.demo.map(str::to_string),
            last_tick: fallback.tick,
            history: fallback
                .demo
                .map(|demo| {
                    vec![GrenadeUsageHistoryPoint {
                        label: demo.to_string(),
                        count: tracked_throws,
                    }]
                })
                .unwrap_or_default(),
        });
    }

    let mut player_counts: HashMap<String, i64> = HashMap::new();
    let mut team_counts: HashMap<String, i64> = HashMap::new();
    let mut demo_counts: HashMap<String, i64> = HashMap::new();
    let mut last: Option<(String, Option<i64>)> = None;
    let mut unknown_last_tick: Option<i64> = None;
    for event in &events {
        let player = event
            .thrower
            .as_deref()
            .or(event.thrower_steamid64.as_deref())
            .filter(|value| !value.is_empty());
        if let Some(player) = player {
            *player_counts.entry(player.to_string()).or_default() += 1;
        }
        if let Some(team) = event
            .thrower_team
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            *team_counts.entry(team.to_string()).or_default() += 1;
        }
        let demo = event
            .demo_filename
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("Unknown demo");
        *demo_counts.entry(demo.to_string()).or_default() += 1;
        if demo != "Unknown demo" {
            let current_key = demo_date_from_filename(demo)
                .map(|date| date.to_string())
                .unwrap_or_else(|| demo.to_string());
            let should_replace = last
                .as_ref()
                .map(|(old_demo, old_tick)| {
                    let old_key = demo_date_from_filename(old_demo)
                        .map(|date| date.to_string())
                        .unwrap_or_else(|| old_demo.clone());
                    current_key > old_key
                        || (current_key == old_key
                            && event.throw_tick.unwrap_or(i64::MIN) >= old_tick.unwrap_or(i64::MIN))
                })
                .unwrap_or(true);
            if should_replace {
                last = Some((demo.to_string(), event.throw_tick));
            }
        } else if event.throw_tick.unwrap_or(i64::MIN) >= unknown_last_tick.unwrap_or(i64::MIN) {
            unknown_last_tick = event.throw_tick;
        }
    }
    if last.is_none() && unknown_last_tick.is_some() {
        last = Some(("Unknown demo".to_string(), unknown_last_tick));
    }

    let tracked_throws = events.len() as i64;
    let peak = demo_counts
        .values()
        .copied()
        .max()
        .unwrap_or(tracked_throws);
    let most_used_player = player_counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    let most_used_team = team_counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    let fallback_player = fallback
        .thrower
        .or_else(|| fallback.usage_throwers.first().map(String::as_str))
        .or(fallback.steamid64)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let fallback_player_throws = if fallback_player.is_some() {
        tracked_throws
    } else {
        0
    };
    let fallback_team = fallback
        .team
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let fallback_team_throws = if fallback_team.is_some() {
        tracked_throws
    } else {
        0
    };
    let mut history = demo_counts.into_iter().collect::<Vec<_>>();
    history.sort_by(|left, right| {
        match (
            demo_date_from_filename(&left.0),
            demo_date_from_filename(&right.0),
        ) {
            (Some(left_date), Some(right_date)) => left_date
                .cmp(&right_date)
                .then_with(|| left.0.cmp(&right.0)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.0.cmp(&right.0),
        }
    });
    Ok(GrenadeUsageStats {
        tracked_throws,
        peak,
        most_used_player: most_used_player
            .as_ref()
            .map(|(name, _)| name.clone())
            .or(fallback_player),
        most_used_player_throws: most_used_player
            .map(|(_, count)| count)
            .unwrap_or(fallback_player_throws),
        most_used_team: most_used_team
            .as_ref()
            .map(|(name, _)| name.clone())
            .or(fallback_team),
        most_used_team_throws: most_used_team
            .map(|(_, count)| count)
            .unwrap_or(fallback_team_throws),
        last_demo: last
            .as_ref()
            .map(|(demo, _)| demo.clone())
            .or_else(|| fallback.demo.map(str::to_string)),
        last_tick: last.and_then(|(_, tick)| tick).or(fallback.tick),
        history: history
            .into_iter()
            .map(|(label, count)| GrenadeUsageHistoryPoint { label, count })
            .collect(),
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

fn trajectory_storage_json(
    trajectory: Option<&Vec<Vec<f64>>>,
    trajectory_preview: Option<&Value>,
    radar: Option<&RadarParams>,
) -> AppResult<(Option<String>, Option<String>)> {
    let preview = if let Some(preview) = trajectory_preview {
        Some(serde_json::to_string(preview)?)
    } else {
        trajectory
            .map(|trajectory| sample_trajectory(trajectory, radar))
            .filter(|preview| !preview.is_empty())
            .map(|preview| serde_json::to_string(&preview))
            .transpose()?
    };
    let full = trajectory.map(serde_json::to_string).transpose()?;
    Ok((preview, full))
}

#[tauri::command]
fn select_import_file() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter(
            "Nade libraries",
            &["json", "messagepack", "msgpack", "mpk", "zip"],
        )
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn import_json(
    path: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<JsonImportReport> {
    let state = state.inner().clone();
    try_begin_import(&state.import_status)?;

    let import_path = path.clone();
    let import_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        import_typed_path_blocking(&import_state, &import_path)
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
async fn import_library_update(state: tauri::State<'_, AppState>) -> AppResult<JsonImportReport> {
    let state = state.inner().clone();
    try_begin_import(&state.import_status)?;
    set_status(&state, "checking_update", 0, 0, "Checking online library");
    let worker_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let manifest = fetch_library_manifest()?;
        if installed_library_version(&worker_state)?.as_deref() == Some(manifest.version.as_str()) {
            return Err(AppError::Import {
                code: "library_already_current",
                message: "The online library is already current".to_string(),
            });
        }
        let path = download_library_file(&worker_state, &manifest)?;
        let import_result = (|| {
            set_status(
                &worker_state,
                "verifying",
                manifest.size,
                manifest.size,
                "Library download verified",
            );
            match parse_messagepack_file(&path)? {
                TypedImportFile::GrenadeIndex(index) => import_index_blocking(
                    &worker_state,
                    &manifest.url,
                    index,
                    Some(&manifest.version),
                )
                .map(JsonImportReport::from),
                TypedImportFile::CoreNades(core_file) => import_core_nades_snapshot_blocking(
                    &worker_state,
                    &manifest.url,
                    core_file,
                    Some(&manifest.version),
                )
                .map(JsonImportReport::core_nades),
            }
        })();
        let _ = fs::remove_file(path);
        import_result
    })
    .await;

    match result {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(err)) => {
            let temporary = state
                .db_path
                .parent()
                .map(|directory| directory.join("library-update.msgpack.part"));
            if let Some(temporary) = temporary {
                let _ = fs::remove_file(temporary);
            }
            set_error(&state, &err.to_string());
            Err(err)
        }
        Err(err) => {
            set_error(&state, &err.to_string());
            Err(AppError::Message(err.to_string()))
        }
    }
}

fn import_screenshot_archive_blocking(
    state: &AppState,
    path: &str,
) -> AppResult<(ImportReport, u64)> {
    const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

    set_status(state, "reading", 0, 0, "Reading screenshot archive");
    let source = fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(BufReader::new(source))
        .map_err(|error| AppError::Message(format!("Invalid screenshot archive: {error}")))?;
    let manifest: ScreenshotArchiveFile = {
        let entry = archive.by_name("grenades.json").map_err(|_| {
            AppError::Message("Screenshot archive is missing grenades.json".to_string())
        })?;
        serde_json::from_reader(BufReader::new(entry)).map_err(|error| {
            AppError::Message(format!("Invalid screenshot archive manifest: {error}"))
        })?
    };
    if manifest.version != SUPPORTED_IMPORT_VERSION {
        return Err(AppError::Message(format!(
            "Unsupported screenshot archive version: {}",
            manifest.version
        )));
    }
    if manifest.grenades.is_empty() {
        return Err(AppError::Message(
            "Screenshot archive contains no grenades".to_string(),
        ));
    }

    let total = manifest.grenades.len() as u64;
    let index = ParserIndex {
        version: Some(manifest.version),
        updated_at: Some(manifest.exported_at.clone()),
        core_nades: Some(false),
        canonical_grenades: manifest
            .grenades
            .iter()
            .map(|record| record.grenade.clone())
            .collect(),
        players: Vec::new(),
        processed_demos: None,
    };
    let mut report = import_index_blocking(state, path, index, None)?;
    let screenshot_root = state
        .db_path
        .parent()
        .ok_or_else(|| AppError::Message("Application data directory is unavailable".to_string()))?
        .join("screenshots")
        .join(format!("archive_{}", report.import_id));

    let import_result = (|| -> AppResult<u64> {
        fs::create_dir_all(&screenshot_root)?;
        let mut conn = open_conn(state)?;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE imports SET kind='screenshot_archive' WHERE id=?1",
            params![report.import_id],
        )?;
        let mut grenade_id_stmt =
            tx.prepare("SELECT id FROM grenades WHERE import_id=?1 AND source_index=?2")?;
        let mut screenshot_stmt = tx.prepare(
            "INSERT INTO grenade_screenshots(
                import_id, grenade_id, image_path, wide_image_path, wide_fov, width, height,
                file_size, wide_file_size, captured_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for (index, record) in manifest.grenades.iter().enumerate() {
            if index % 100 == 0 {
                set_status(
                    state,
                    "extracting_screenshots",
                    index as u64,
                    total,
                    "Extracting screenshots",
                );
            }
            let grenade_id: i64 = grenade_id_stmt
                .query_row(params![report.import_id, index as i64], |row| row.get(0))?;
            let folder = screenshot_root.join(format!("{:02x}", (grenade_id as u64) & 0xff));
            fs::create_dir_all(&folder)?;
            let normal_path = folder.join(format!("{grenade_id}.jpg"));
            let wide_path = folder.join(format!(
                "{grenade_id}_fov{}.jpg",
                record.screenshots.wide_fov
            ));
            let (width, height, normal_size) = extract_archive_jpeg(
                &mut archive,
                &record.screenshots.normal,
                &normal_path,
                MAX_IMAGE_BYTES,
            )?;
            let (_, _, wide_size) = extract_archive_jpeg(
                &mut archive,
                &record.screenshots.wide,
                &wide_path,
                MAX_IMAGE_BYTES,
            )?;
            screenshot_stmt.execute(params![
                report.import_id,
                grenade_id,
                resource_string(&normal_path),
                resource_string(&wide_path),
                record.screenshots.wide_fov,
                width,
                height,
                normal_size,
                wide_size,
                manifest.exported_at,
            ])?;
        }
        drop(screenshot_stmt);
        drop(grenade_id_stmt);
        tx.commit()?;
        Ok(total * 2)
    })();

    match import_result {
        Ok(screenshot_count) => {
            report.source_path = path.to_string();
            set_status(
                state,
                "done",
                total,
                total,
                "Screenshot archive import complete",
            );
            Ok((report, screenshot_count))
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&screenshot_root);
            let mut conn = open_conn(state)?;
            let _ = delete_import_from_conn(&mut conn, report.import_id);
            Err(error)
        }
    }
}

fn extract_archive_jpeg<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    archive_path: &str,
    destination: &Path,
    max_bytes: u64,
) -> AppResult<(u32, u32, u64)> {
    let normalized = archive_path.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.split('/').any(|part| part == "..")
        || !normalized.starts_with("screenshots/")
    {
        return Err(AppError::Message(format!(
            "Unsafe screenshot path in archive: {archive_path}"
        )));
    }
    let mut entry = archive
        .by_name(&normalized)
        .map_err(|_| AppError::Message(format!("Screenshot entry is missing: {archive_path}")))?;
    if entry.is_dir() || entry.size() == 0 || entry.size() > max_bytes {
        return Err(AppError::Message(format!(
            "Invalid screenshot entry: {archive_path}"
        )));
    }
    let size = entry.size();
    let mut bytes = Vec::with_capacity(size as usize);
    entry.read_to_end(&mut bytes)?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
        .map_err(|error| AppError::Message(format!("Invalid JPEG {archive_path}: {error}")))?;
    fs::write(destination, &bytes)?;
    Ok((image.width(), image.height(), size))
}

#[tauri::command]
fn get_import_status(state: tauri::State<'_, AppState>) -> ImportStatus {
    state
        .import_status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

fn import_index_blocking(
    state: &AppState,
    path: &str,
    index: ParserIndex,
    library_version: Option<&str>,
) -> AppResult<ImportReport> {
    let total = index.canonical_grenades.len() as u64;
    set_status(state, "preparing", 0, total, "Preparing local database");
    let is_core_snapshot = index.core_nades.unwrap_or(false);
    let import_kind = if is_core_snapshot {
        "core_nades"
    } else {
        "grenade_index"
    };

    let radars = &state.radars;
    let mut conn = open_conn(state)?;
    init_schema(&conn)?;
    seed_assets(&conn, &state.resource_dir)?;
    seed_spawn_points(&conn, &state.resource_dir)?;

    let imported_at = Utc::now().to_rfc3339();
    let unique_maps = index
        .canonical_grenades
        .iter()
        .map(|g| g.map.clone())
        .collect::<HashSet<_>>();
    let map_count = unique_maps.len() as u64;
    let mut demo_metadata = BTreeMap::new();
    for grenade in &index.canonical_grenades {
        collect_grenade_metadata(grenade, &mut demo_metadata);
    }
    for player in &index.players {
        collect_player_metadata(player, &mut demo_metadata);
    }
    if let Some(processed_demos) = &index.processed_demos {
        collect_demo_metadata_from_value(processed_demos, &mut demo_metadata);
    }

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

    for player in &index.players {
        insert_import_player(&tx, import_id, player)?;
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO grenades(
                import_id, source_index, map, side, grenade_type, is_core, throw_keys, coordinates,
                thrower, thrower_steamid64, thrower_team, airtime, usage_count, usage_throwers_json, demo_filename, throw_tick,
                lineup_tick, tickrate, round_time_seconds, start_pos_x, start_pos_y, start_pos_z,
                explode_pos_x, explode_pos_y, explode_pos_z, start_map_x, start_map_y,
                explode_map_x, explode_map_y, trajectory_preview_json, trajectory_json
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31
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
            let (trajectory_preview, trajectory_json) = trajectory_storage_json(
                g.trajectory.as_ref(),
                g.trajectory_preview.as_ref(),
                radar,
            )?;

            stmt.execute(params![
                import_id,
                idx as i64,
                g.map,
                g.side.as_deref().unwrap_or("Any"),
                g.grenade_type.as_deref().unwrap_or("smoke"),
                if is_core_snapshot { 1 } else { 0 },
                g.throw_keys.as_deref(),
                g.coordinates.as_deref(),
                g.thrower.as_deref(),
                g.thrower_steamid64.as_deref(),
                g.thrower_team.as_deref(),
                g.airtime,
                g.usage_count.unwrap_or(1),
                serde_json::to_string(&g.usage_throwers.clone().unwrap_or_default())?,
                g.demo_filename.as_deref(),
                g.throw_tick,
                g.lineup_tick,
                round_tickrate(g.tickrate),
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
            let grenade_id = tx.last_insert_rowid();
            for event in &g.usage_events {
                insert_usage_event(&tx, import_id, grenade_id, event)?;
            }
            add_canonical_fallback_players(&tx, import_id, g)?;
        }
    }

    insert_demo_metadata(&tx, import_id, &demo_metadata)?;
    populate_import_map_players(&tx, import_id)?;

    if let Some(version) = library_version {
        tx.execute(
            "INSERT INTO app_meta(key, value) VALUES ('library_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![version],
        )?;
        tx.execute(
            "INSERT INTO app_meta(key, value) VALUES ('library_import_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![import_id.to_string()],
        )?;
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

fn import_players_from_conn(
    conn: &Connection,
    import_id: i64,
    team_name: Option<&str>,
    map: Option<&str>,
    tournament: Option<&str>,
) -> AppResult<Vec<ImportPlayer>> {
    let mut players = Vec::new();
    let mut seen = HashSet::new();
    let mut add_player = |steamid64: Option<String>,
                          name: Option<String>,
                          team: Option<String>,
                          side: Option<String>| {
        let player = ImportPlayer {
            steamid64: steamid64.unwrap_or_default(),
            name: name.unwrap_or_default(),
            team_name: team.unwrap_or_default(),
            side: side.unwrap_or_default(),
        };
        if player.steamid64.is_empty() && player.name.is_empty() {
            return;
        }
        if team_name.is_some_and(|expected| player.team_name != expected) {
            return;
        }
        let key = (
            player.steamid64.clone(),
            player.name.clone(),
            player.team_name.clone(),
            player.side.clone(),
        );
        if seen.insert(key) {
            players.push(player);
        }
    };

    let player_sql = "SELECT DISTINCT steamid64, player_name, team_name, side
         FROM import_map_players
         WHERE import_id=?1
           AND (?2 IS NULL OR map=?2)
           AND (?3 IS NULL OR team_name=?3)
           AND (?4 IS NULL OR tournament=?4)
         ORDER BY team_name, player_name, steamid64, side";
    let mut stmt = conn.prepare(player_sql)?;
    let rows = stmt.query_map(params![import_id, map, team_name, tournament], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    for row in rows {
        let (steamid64, name, team, side) = row?;
        add_player(steamid64, name, team, side);
    }

    players.sort_by(|left, right| {
        left.team_name
            .cmp(&right.team_name)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.steamid64.cmp(&right.steamid64))
    });
    Ok(players)
}

fn get_import_teams_blocking(
    map: Option<String>,
    tournament: Option<String>,
    state: &AppState,
) -> AppResult<Vec<ImportTeam>> {
    let conn = open_conn(state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    let players = import_players_from_conn(
        &conn,
        import_id,
        None,
        map.as_deref(),
        tournament.as_deref(),
    )?;
    Ok(import_teams_from_players(players))
}

fn import_teams_from_players(players: Vec<ImportPlayer>) -> Vec<ImportTeam> {
    let mut teams: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for player in players {
        if player.team_name.is_empty() || player.steamid64.is_empty() {
            continue;
        }
        teams
            .entry(player.team_name)
            .or_default()
            .insert(player.steamid64);
    }
    teams
        .into_iter()
        .map(|(team_name, players)| ImportTeam {
            team_name,
            player_count: players.len() as i64,
        })
        .collect()
}

#[tauri::command]
async fn get_import_teams(
    map: Option<String>,
    tournament: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<ImportTeam>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_import_teams_blocking(map, tournament, &state))
        .await
        .map_err(|error| AppError::Message(format!("Team filter query failed: {error}")))?
}

fn get_import_players_blocking(
    team_name: Option<String>,
    map: Option<String>,
    tournament: Option<String>,
    state: &AppState,
) -> AppResult<Vec<ImportPlayer>> {
    let conn = open_conn(state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    import_players_from_conn(
        &conn,
        import_id,
        team_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        map.as_deref(),
        tournament
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
}

#[tauri::command]
async fn get_import_players(
    team_name: Option<String>,
    map: Option<String>,
    tournament: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<ImportPlayer>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_import_players_blocking(team_name, map, tournament, &state)
    })
    .await
    .map_err(|error| AppError::Message(format!("Player filter query failed: {error}")))?
}

fn get_import_tournaments_blocking(
    map: Option<String>,
    state: &AppState,
) -> AppResult<Vec<ImportTournament>> {
    let conn = open_conn(state)?;
    let import_id = active_import_id(&conn)?
        .ok_or_else(|| AppError::Message("No active import".to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT dm.tournament, MIN(dm.demo_date), MAX(dm.demo_date)
         FROM demo_metadata dm
         WHERE dm.import_id=?1 AND (
             EXISTS (
                 SELECT 1
                 FROM grenades g INDEXED BY idx_grenades_import_demo_map
                 WHERE g.import_id=dm.import_id
                   AND g.demo_filename=dm.demo_filename
                   AND g.map=?2
             )
             OR EXISTS (
                 SELECT 1
                 FROM grenade_usage_events ue INDEXED BY idx_grenade_usage_events_import_demo
                 JOIN grenades g ON g.id=ue.grenade_id
                 WHERE ue.import_id=dm.import_id
                   AND ue.demo_filename=dm.demo_filename
                   AND g.map=?2
             )
         )
         GROUP BY dm.tournament
         ORDER BY MAX(dm.demo_date) DESC, dm.tournament COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![import_id, map], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    rows.map(|row| -> rusqlite::Result<ImportTournament> {
        let (name, start_date, end_date) = row?;
        Ok(ImportTournament {
            name,
            start_date,
            end_date,
        })
    })
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(AppError::from)
}

#[tauri::command]
async fn get_import_tournaments(
    map: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<ImportTournament>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_import_tournaments_blocking(map, &state))
        .await
        .map_err(|error| AppError::Message(format!("Tournament filter query failed: {error}")))?
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
    get_active_import_from_conn(conn)?
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
    let screenshot_root = state.db_path.parent().map(|directory| {
        directory
            .join("screenshots")
            .join(format!("archive_{import_id}"))
    });
    if let Some(screenshot_root) = screenshot_root {
        let _ = fs::remove_dir_all(screenshot_root);
    }
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
        "DELETE FROM import_map_players WHERE import_id=?1",
        params![import_id],
    )?;
    tx.execute(
        "DELETE FROM grenade_usage_events WHERE import_id=?1",
        params![import_id],
    )?;
    tx.execute(
        "DELETE FROM import_players WHERE import_id=?1",
        params![import_id],
    )?;
    tx.execute(
        "DELETE FROM demo_metadata WHERE import_id=?1",
        params![import_id],
    )?;
    tx.execute(
        "DELETE FROM grenades WHERE import_id=?1",
        params![import_id],
    )?;
    tx.execute("DELETE FROM imports WHERE id=?1", params![import_id])?;
    let remote_import_id = tx
        .query_row(
            "SELECT value FROM app_meta WHERE key='library_import_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if remote_import_id
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        == Some(import_id)
    {
        tx.execute(
            "DELETE FROM app_meta WHERE key IN ('library_import_id', 'library_version')",
            [],
        )?;
    }

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
    get_active_import_from_conn(conn)
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
    conn
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
        .ok_or_else(|| AppError::Message("Import not found".to_string()))
}

#[tauri::command]
fn get_maps(state: tauri::State<'_, AppState>) -> AppResult<Vec<MapSummary>> {
    let conn = open_conn(&state)?;
    let active = active_import_id(&conn)?;
    let radars = &state.radars;
    let mut stmt = conn.prepare(
        "SELECT a.name, a.label, a.preview_image_path, a.map_image_path, a.lower_map_image_path,
         COALESCE(g.count, 0) AS grenade_count
         FROM map_assets a
         LEFT JOIN (
             SELECT g.map, COUNT(*) AS count FROM grenades g WHERE g.import_id = ?1 AND g.usage_count >= ?2 GROUP BY g.map
         ) g ON g.map = a.name
         ORDER BY grenade_count DESC, a.label ASC",
    )?;
    let rows = stmt.query_map(
        params![active.unwrap_or(-1), public_min_usage_count(&conn)?],
        |row| {
            let name: String = row.get(0)?;
            let lower_map_image_path: Option<String> = row.get(4)?;
            let radar_split_z = radar_split_for_map(radars, &name);
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
    radars: &HashMap<String, RadarParams>,
    import_id: i64,
    map: &str,
) -> AppResult<MapSummary> {
    let mut summary = conn.query_row(
        "SELECT a.name, a.label, a.preview_image_path, a.map_image_path, a.lower_map_image_path,
         (SELECT COUNT(*) FROM grenades g WHERE g.import_id=?1 AND g.map=a.name AND g.usage_count >= ?3)
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
    summary.radar_split_z = radar_split_for_map(radars, &summary.name);
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

/// Overview totals derived from a single grouped scan of the filtered set.
struct OverviewBreakdown {
    grenade_count: i64,
    type_counts: BTreeMap<String, i64>,
    side_counts: BTreeMap<String, i64>,
}

/// Folds `(grenade_type, side, count)` groups into the total plus the per-type
/// and per-side breakdowns.
fn fold_overview_breakdown(rows: Vec<(String, String, i64)>) -> OverviewBreakdown {
    let mut breakdown = OverviewBreakdown {
        grenade_count: 0,
        type_counts: BTreeMap::new(),
        side_counts: BTreeMap::new(),
    };
    for (grenade_type, side, count) in rows {
        breakdown.grenade_count += count;
        *breakdown.type_counts.entry(grenade_type).or_default() += count;
        *breakdown.side_counts.entry(side).or_default() += count;
    }
    breakdown
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
    let summary = map_summary(&conn, &state.radars, import_id, &map)?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(import_id), Box::new(map.clone())];
    let visibility = visibility_sql(&conn, &mut args, "g")?;
    let filter = filter_sql(&filters, &mut args, "g");
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), &summary, &mut args, "g");
    let params_ref = rusqlite::params_from_iter(args.iter().map(|b| &**b));

    // One pass over the filtered set feeds the total plus the per-type and
    // per-side breakdowns, instead of scanning the same rows three times.
    let breakdown_sql = format!(
        "SELECT g.grenade_type, g.side, COUNT(*) FROM grenades g
         WHERE g.import_id=? AND g.map=?{}{}{}
         GROUP BY g.grenade_type, g.side",
        visibility, filter, radar_filter
    );
    let breakdown_rows = {
        let mut stmt = conn.prepare(&breakdown_sql)?;
        let rows = stmt.query_map(params_ref, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let OverviewBreakdown {
        grenade_count,
        type_counts,
        side_counts,
    } = fold_overview_breakdown(breakdown_rows);

    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(import_id), Box::new(map.clone())];
    let visibility = visibility_sql(&conn, &mut args, "g")?;
    let filter = filter_sql(&filters, &mut args, "g");
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), &summary, &mut args, "g");
    let params_ref = rusqlite::params_from_iter(args.iter().map(|b| &**b));
    let cluster_sql = format!(
        "SELECT
           CAST(g.{x_col} / {cell} AS INTEGER) AS cx,
           CAST(g.{y_col} / {cell} AS INTEGER) AS cy,
           AVG(g.{x_col}), AVG(g.{y_col}), COUNT(*), MIN(g.id),
           GROUP_CONCAT(DISTINCT g.side), GROUP_CONCAT(DISTINCT g.grenade_type)
         FROM grenades g
         WHERE g.import_id=? AND g.map=? AND g.{x_col} IS NOT NULL AND g.{y_col} IS NOT NULL {}{}{}
         GROUP BY cx, cy
         ORDER BY COUNT(*) DESC",
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
            let has_t = side_values.contains(&"T");
            let has_ct = side_values.contains(&"CT");
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
    Ok(MapOverview {
        map: summary,
        grenade_count,
        clusters,
        type_counts,
        side_counts,
    })
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
    let summary = map_summary(&conn, &state.radars, import_id, &map)?;
    let (cx, cy) = parse_cluster_id(&cluster_id)?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(import_id),
        Box::new(map),
        Box::new(cx),
        Box::new(cy),
    ];
    let visibility = visibility_sql(&conn, &mut args, "g")?;
    let filter = filter_sql(&filters, &mut args, "g");
    let radar_filter = radar_level_sql(filters.radar_level.as_deref(), &summary, &mut args, "g");
    let split_literal = summary
        .radar_split_z
        .map(|v| v.to_string())
        .unwrap_or_else(|| "NULL".to_string());
    let has_lower_literal = if summary.has_lower_radar { 1 } else { 0 };
    let pagination = if limit == 0 {
        String::new()
    } else {
        args.push(Box::new(limit as i64));
        args.push(Box::new(offset as i64));
        " LIMIT ? OFFSET ?".to_string()
    };
    let sql = format!(
        "SELECT {GRENADE_PREVIEW_COLUMNS}, {split_literal} AS radar_split_z, {has_lower_literal} AS has_lower_radar FROM grenades g
         WHERE g.import_id=? AND g.map=? AND CAST(g.{x_col} / {cell} AS INTEGER)=? AND CAST(g.{y_col} / {cell} AS INTEGER)=?{}{}{}
         ORDER BY g.usage_count DESC, g.id ASC{}",
        visibility, filter, radar_filter, pagination
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
    let radars = &state.radars;
    let mut stmt = conn.prepare(&format!(
        "SELECT {GRENADE_PREVIEW_COLUMNS}, g.usage_throwers_json, g.demo_filename,
                g.throw_tick, g.lineup_tick, g.tickrate, g.round_time_seconds,
                g.start_pos_x, g.start_pos_y, g.start_pos_z,
                g.explode_pos_x, g.explode_pos_y,
                a.map_image_path, a.lower_map_image_path, a.preview_image_path,
                s.image_path AS screenshot_image_path,
                s.wide_image_path AS screenshot_wide_image_path
          FROM grenades g
          LEFT JOIN map_assets a ON a.name=g.map
          LEFT JOIN grenade_screenshots s ON s.grenade_id=g.id
         WHERE g.id=?1 AND g.import_id=(
             SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='active_import_id'
         )"
    ))?;
    let mut detail = stmt.query_row(params![id], |row| {
        let mut preview = grenade_preview_from_row(row)?;
        let lower_map_image_path: Option<String> = row.get("lower_map_image_path")?;
        let split_z = radar_split_for_map(radars, &preview.map);
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
        let demo_filename: Option<String> = row.get("demo_filename")?;
        let throw_tick: Option<i64> = row.get("throw_tick")?;
        Ok(GrenadeDetail {
            preview,
            usage_throwers: throwers_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            demo_filename,
            throw_tick,
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
            screenshot_image_path: row.get("screenshot_image_path")?,
            screenshot_wide_image_path: row.get("screenshot_wide_image_path")?,
            usage_stats: GrenadeUsageStats::default(),
        })
    })?;
    drop(stmt);
    detail.usage_stats = usage_stats_from_conn(
        &conn,
        id,
        UsageFallback {
            usage_count: detail.preview.usage_count,
            usage_throwers: &detail.usage_throwers,
            thrower: detail.preview.thrower.as_deref(),
            steamid64: detail.preview.thrower_steamid64.as_deref(),
            team: detail.preview.thrower_team.as_deref(),
            demo: detail.demo_filename.as_deref(),
            tick: detail.throw_tick,
        },
    )?;
    Ok(detail)
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
        "SELECT g.id AS grenade_id, g.source_index, g.map, g.side, g.grenade_type, g.throw_keys, g.coordinates,
            g.thrower, g.thrower_steamid64, g.thrower_team, g.airtime, g.usage_count, g.usage_throwers_json, g.demo_filename, g.throw_tick,
            g.lineup_tick, g.tickrate, g.round_time_seconds, g.start_pos_x, g.start_pos_y, g.start_pos_z,
            g.explode_pos_x, g.explode_pos_y, g.explode_pos_z,
            g.start_map_x, g.start_map_y, g.explode_map_x, g.explode_map_y,
            g.trajectory_json, g.trajectory_preview_json
         FROM grenades g
         WHERE g.import_id=?1 AND g.is_core=1
         ORDER BY g.map ASC, g.grenade_type ASC, g.usage_count DESC, g.id ASC",
    )?;
    let mut rows = stmt.query(params![import_id])?;
    let mut canonical_grenades = Vec::new();
    while let Some(row) = rows.next()? {
        let grenade_id: i64 = row.get("grenade_id")?;
        let mut grenade = raw_grenade_from_row(row)?;
        grenade.usage_events = load_usage_events(&conn, grenade_id)?;
        canonical_grenades.push(grenade);
    }
    let file = ParserIndex {
        version: Some(1),
        updated_at: Some(Utc::now().to_rfc3339()),
        core_nades: Some(true),
        canonical_grenades,
        players: Vec::new(),
        processed_demos: None,
    };
    let text = serde_json::to_string_pretty(&file)?;
    fs::write(&path, text)?;
    Ok(Some(CoreNadesExportReport {
        path: resource_string(&path),
        grenade_count: file.canonical_grenades.len() as i64,
    }))
}

fn import_core_nades_snapshot_blocking(
    state: &AppState,
    path: &str,
    core_file: CoreNadesFile,
    library_version: Option<&str>,
) -> AppResult<ImportReport> {
    let total = core_file.grenades.len() as u64;
    set_status(
        state,
        "preparing",
        0,
        total,
        "Preparing Core Nades snapshot",
    );

    let radars = &state.radars;
    let mut conn = open_conn(state)?;
    init_schema(&conn)?;
    seed_assets(&conn, &state.resource_dir)?;
    seed_spawn_points(&conn, &state.resource_dir)?;

    let imported_at = Utc::now().to_rfc3339();
    let unique_maps = core_file
        .grenades
        .iter()
        .map(|g| g.map.clone())
        .collect::<HashSet<_>>();
    let map_count = unique_maps.len() as u64;
    let mut demo_metadata = BTreeMap::new();
    for grenade in &core_file.grenades {
        record_demo_metadata(&mut demo_metadata, grenade.demo_filename.as_deref(), None);
        for event in &grenade.usage_events {
            record_demo_metadata(&mut demo_metadata, event.demo_filename.as_deref(), None);
        }
    }
    for player in &core_file.players {
        collect_player_metadata(player, &mut demo_metadata);
    }

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

    for player in &core_file.players {
        insert_import_player(&tx, import_id, player)?;
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO grenades(
                import_id, source_index, map, side, grenade_type, is_core, throw_keys, coordinates,
                thrower, thrower_steamid64, thrower_team, airtime, usage_count, usage_throwers_json, demo_filename, throw_tick,
                lineup_tick, tickrate, round_time_seconds, start_pos_x, start_pos_y, start_pos_z,
                explode_pos_x, explode_pos_y, explode_pos_z, start_map_x, start_map_y,
                explode_map_x, explode_map_y, trajectory_preview_json, trajectory_json
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30
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
            let (trajectory_preview, trajectory_json) = trajectory_storage_json(
                g.trajectory.as_ref(),
                g.trajectory_preview.as_ref(),
                radar,
            )?;

            stmt.execute(params![
                import_id,
                g.source_index.unwrap_or(idx as i64),
                g.map,
                g.side,
                g.grenade_type,
                g.throw_keys.as_deref(),
                g.coordinates.as_deref(),
                g.thrower.as_deref(),
                g.thrower_steamid64.as_deref(),
                g.thrower_team.as_deref(),
                g.airtime,
                g.usage_count.unwrap_or(1),
                serde_json::to_string(&g.usage_throwers.clone().unwrap_or_default())?,
                g.demo_filename.as_deref(),
                g.throw_tick,
                g.lineup_tick,
                round_tickrate(g.tickrate),
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
            let grenade_id = tx.last_insert_rowid();
            for event in &g.usage_events {
                insert_usage_event(&tx, import_id, grenade_id, event)?;
            }
            add_core_fallback_players(&tx, import_id, g)?;
        }
    }

    insert_demo_metadata(&tx, import_id, &demo_metadata)?;
    populate_import_map_players(&tx, import_id)?;

    if let Some(version) = library_version {
        tx.execute(
            "INSERT INTO app_meta(key, value) VALUES ('library_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![version],
        )?;
        tx.execute(
            "INSERT INTO app_meta(key, value) VALUES ('library_import_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![import_id.to_string()],
        )?;
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
    type SimilarBase = (i64, String, String, Option<f64>, Option<f64>);
    let base: Option<SimilarBase> = conn
        .query_row(
            "SELECT g.import_id, g.map, g.grenade_type, g.explode_map_x, g.explode_map_y
              FROM grenades g
              WHERE g.id=?1 AND g.import_id=(
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
    let summary = map_summary(&conn, &state.radars, import_id, &map)?;
    let split_literal = summary
        .radar_split_z
        .map(|v| v.to_string())
        .unwrap_or_else(|| "NULL".to_string());
    let has_lower_literal = if summary.has_lower_radar { 1 } else { 0 };
    let mut stmt = conn.prepare(
        &format!("SELECT {GRENADE_PREVIEW_COLUMNS}, {split_literal} AS radar_split_z, {has_lower_literal} AS has_lower_radar,
          ((COALESCE(g.explode_map_x, 0)-?4)*(COALESCE(g.explode_map_x, 0)-?4) + (COALESCE(g.explode_map_y, 0)-?5)*(COALESCE(g.explode_map_y, 0)-?5)) AS dist
          FROM grenades g
          WHERE g.import_id=?1 AND g.map=?2 AND g.grenade_type=?3 AND g.id<>?6 AND g.usage_count >= ?8
          ORDER BY dist ASC, g.usage_count DESC LIMIT ?7"),
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

    #[test]
    fn asset_directories_are_limited_to_image_directories() {
        let root = Path::new("/resolved/resources");
        assert_eq!(
            asset_directories(root),
            [
                root.join("maps").join("2d"),
                root.join("maps").join("preview")
            ]
        );
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn validates_online_library_manifest_security_fields() {
        let valid = LibraryManifest {
            version: "2026.08.26.1".to_string(),
            url: "https://example.com/library.msgpack".to_string(),
            size: 600 * 1024 * 1024,
            sha256: "a".repeat(64),
        };
        assert!(validate_library_manifest(&valid).is_ok());

        let mut invalid_url = valid.clone();
        invalid_url.url = "http://example.com/library.msgpack".to_string();
        assert!(validate_library_manifest(&invalid_url).is_err());

        let mut invalid_hash = valid;
        invalid_hash.sha256 = "not-a-sha256".to_string();
        assert!(validate_library_manifest(&invalid_hash).is_err());
    }

    #[test]
    fn overview_breakdown_folds_groups_into_total_and_per_field_counts() {
        let breakdown = fold_overview_breakdown(vec![
            ("smoke".to_string(), "T".to_string(), 3),
            ("smoke".to_string(), "CT".to_string(), 2),
            ("flash".to_string(), "T".to_string(), 4),
        ]);
        assert_eq!(breakdown.grenade_count, 9);
        assert_eq!(breakdown.type_counts.get("smoke"), Some(&5));
        assert_eq!(breakdown.type_counts.get("flash"), Some(&4));
        assert_eq!(breakdown.side_counts.get("T"), Some(&7));
        assert_eq!(breakdown.side_counts.get("CT"), Some(&2));
    }

    #[test]
    fn single_pass_breakdown_matches_separate_grouped_queries() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        insert_import(&conn, 1);
        for (id, grenade_type, side) in [
            (1, "smoke", "T"),
            (2, "smoke", "T"),
            (3, "smoke", "CT"),
            (4, "flash", "CT"),
            (5, "HE", "T"),
        ] {
            conn.execute(
                "INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type, usage_count)
                 VALUES (?1, 1, ?1, 'de_test', ?2, ?3, 1)",
                params![id, side, grenade_type],
            )
            .unwrap();
        }

        let rows = conn
            .prepare(
                "SELECT g.grenade_type, g.side, COUNT(*) FROM grenades g
                 WHERE g.import_id=1 AND g.map='de_test'
                 GROUP BY g.grenade_type, g.side",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let breakdown = fold_overview_breakdown(rows);

        let grouped = |field: &str| -> BTreeMap<String, i64> {
            conn.prepare(&format!(
                "SELECT g.{field}, COUNT(*) FROM grenades g
                 WHERE g.import_id=1 AND g.map='de_test' GROUP BY g.{field}"
            ))
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<Result<BTreeMap<_, _>, _>>()
            .unwrap()
        };

        assert_eq!(
            breakdown.grenade_count,
            count(&conn, "SELECT COUNT(*) FROM grenades WHERE import_id=1")
        );
        assert_eq!(breakdown.type_counts, grouped("grenade_type"));
        assert_eq!(breakdown.side_counts, grouped("side"));
    }

    fn temporary_test_state(name: &str) -> (AppState, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "nade-viewer-{name}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        (
            AppState {
                db_path: root.join("test.sqlite"),
                resource_dir: root.join("resources"),
                radars: Arc::new(HashMap::new()),
                import_status: Arc::new(Mutex::new(ImportStatus::default())),
            },
            root,
        )
    }

    fn round_trip_core_trajectory(json: &str) -> RawGrenade {
        let TypedImportFile::CoreNades(file) = parse_import(json.as_bytes()).unwrap() else {
            panic!("expected Core Nades snapshot");
        };
        let grenade = &file.grenades[0];
        let (trajectory_preview_json, trajectory_json) = trajectory_storage_json(
            grenade.trajectory.as_ref(),
            grenade.trajectory_preview.as_ref(),
            None,
        )
        .unwrap();

        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        insert_import(&conn, 1);
        conn.execute(
            "INSERT INTO grenades(
                import_id, source_index, map, side, grenade_type, is_core,
                 throw_keys, trajectory_preview_json, trajectory_json
             ) VALUES (1, 0, ?1, ?2, ?3, 1, ?4, ?5, ?6)",
            params![
                grenade.map,
                grenade.side,
                grenade.grenade_type,
                grenade.throw_keys,
                trajectory_preview_json,
                trajectory_json
            ],
        )
        .unwrap();
        let exported = conn
            .query_row(
             "SELECT source_index, map, side, grenade_type, throw_keys, coordinates,
                    thrower, thrower_steamid64, thrower_team, airtime, usage_count, usage_throwers_json, demo_filename, throw_tick,
                    lineup_tick, tickrate, round_time_seconds, start_pos_x, start_pos_y, start_pos_z,
                    explode_pos_x, explode_pos_y, explode_pos_z,
                    start_map_x, start_map_y, explode_map_x, explode_map_y,
                    trajectory_json, trajectory_preview_json
                  FROM grenades g WHERE g.import_id=1",
                [],
                raw_grenade_from_row,
            )
            .unwrap();
        let exported_json = serde_json::to_vec(&ParserIndex {
            version: Some(1),
            updated_at: Some("now".to_string()),
            core_nades: Some(true),
            canonical_grenades: vec![exported],
            players: Vec::new(),
            processed_demos: None,
        })
        .unwrap();
        let TypedImportFile::GrenadeIndex(reimported) =
            parse_import(exported_json.as_slice()).unwrap()
        else {
            panic!("expected canonical Core export");
        };
        reimported.canonical_grenades.into_iter().next().unwrap()
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
    fn deserializes_both_supported_import_formats() {
        let index =
            parse_import(r#"{"version":1,"updated_at":"now","canonical_grenades":[]}"#.as_bytes())
                .unwrap();
        assert!(matches!(index, TypedImportFile::GrenadeIndex(_)));

        let core =
            parse_import(r#"{"version":1,"exported_at":"now","grenades":[]}"#.as_bytes()).unwrap();
        assert!(matches!(core, TypedImportFile::CoreNades(_)));

        let archive: ScreenshotArchiveFile = serde_json::from_str(
            r#"{
                "version": 1,
                "exported_at": "now",
                "grenades": [{
                    "map": "de_test",
                    "throw_keys": "M1+JUMP",
                    "screenshots": {
                        "normal": "screenshots/a.jpg",
                        "wide": "screenshots/b.jpg",
                        "wide_fov": 120
                    }
                }]
            }"#,
        )
        .unwrap();
        assert_eq!(
            archive.grenades[0].grenade.throw_keys.as_deref(),
            Some("M1+JUMP")
        );
    }

    #[test]
    fn canonical_and_core_imports_execute_with_nadegrid_fields() {
        let (state, root) = temporary_test_state("format-import");
        let TypedImportFile::GrenadeIndex(index) = parse_import(
            br#"{
                "version": 1,
                "canonical_grenades": [{
                    "map": "de_test",
                    "side": "T",
                    "grenade_type": "smoke",
                    "throw_keys": "M1+JUMP",
                    "thrower": "Alice",
                    "thrower_steamid64": "76561198000000001",
                    "thrower_team": "Alpha",
                    "usage_count": 1,
                    "demo_filename": "Cup_match_2024-01-02.dem",
                    "tickrate": 64.0,
                    "usage_events": [{
                        "demo_filename": "Cup_match_2024-01-02.dem",
                        "throw_tick": 100,
                        "thrower": "Alice",
                        "thrower_steamid64": "76561198000000001",
                        "thrower_team": "Alpha"
                    }]
                }],
                "players": [{
                    "demo_filename": "Cup_match_2024-01-02.dem",
                    "steamid64": "76561198000000001",
                    "name": "Alice",
                    "team_name": "Alpha",
                    "side": "T"
                }]
            }"#
            .as_slice(),
        )
        .unwrap() else {
            panic!("expected canonical import");
        };
        let canonical_report =
            import_index_blocking(&state, "canonical.json", index, None).unwrap();

        let TypedImportFile::CoreNades(core) = parse_import(
            br#"{
                "version": 1,
                "exported_at": "now",
                "grenades": [{
                    "map": "de_test",
                    "side": "CT",
                    "grenade_type": "flash",
                    "throw_keys": "M2",
                    "tickrate": 128.5,
                    "usage_events": [{
                        "demo_filename": "Cup_match_2024-01-03.dem",
                        "throw_tick": 200,
                        "thrower": "Bob",
                        "thrower_steamid64": "76561198000000002",
                        "thrower_team": "Beta"
                    }]
                }]
            }"#
            .as_slice(),
        )
        .unwrap() else {
            panic!("expected Core Nades import");
        };
        let core_report =
            import_core_nades_snapshot_blocking(&state, "core.json", core, None).unwrap();

        let conn = open_conn(&state).unwrap();
        let canonical: (String, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT throw_keys, thrower_steamid64, tickrate FROM grenades WHERE import_id=?1",
                params![canonical_report.import_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            canonical,
            (
                "M1+JUMP".to_string(),
                Some("76561198000000001".to_string()),
                Some(64)
            )
        );
        let core: (String, Option<i64>) = conn
            .query_row(
                "SELECT throw_keys, tickrate FROM grenades WHERE import_id=?1",
                params![core_report.import_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(core, ("M2".to_string(), Some(129)));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_usage_events"), 2);
        assert!(count(&conn, "SELECT COUNT(*) FROM import_players") >= 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM demo_metadata"), 2);
        assert_eq!(
            import_players_from_conn(
                &conn,
                canonical_report.import_id,
                None,
                Some("de_test"),
                None,
            )
            .unwrap()[0]
                .name,
            "Alice"
        );
        assert_eq!(
            import_players_from_conn(
                &conn,
                canonical_report.import_id,
                Some("Alpha"),
                Some("de_test"),
                Some("Cup"),
            )
            .unwrap()[0]
                .steamid64,
            "76561198000000001"
        );
        assert!(count(&conn, "SELECT COUNT(*) FROM import_map_players") >= 2);
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn team_counts_match_unique_selectable_players() {
        let teams = import_teams_from_players(vec![
            ImportPlayer {
                steamid64: "76561198000000001".to_string(),
                name: "Alice".to_string(),
                team_name: "Alpha".to_string(),
                side: "T".to_string(),
            },
            ImportPlayer {
                steamid64: "76561198000000001".to_string(),
                name: "Alice".to_string(),
                team_name: "Alpha".to_string(),
                side: "CT".to_string(),
            },
            ImportPlayer {
                steamid64: "".to_string(),
                name: "Alice".to_string(),
                team_name: "Alpha".to_string(),
                side: "T".to_string(),
            },
            ImportPlayer {
                steamid64: "76561198000000002".to_string(),
                name: "Bob".to_string(),
                team_name: "Alpha".to_string(),
                side: "CT".to_string(),
            },
        ]);
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].team_name, "Alpha");
        assert_eq!(teams[0].player_count, 2);
    }

    #[test]
    fn fresh_schema_uses_throw_keys_and_usage_tables() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let columns = conn
            .prepare("PRAGMA table_info(grenades)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "throw_keys"));
        for table in [
            "grenade_usage_events",
            "import_players",
            "demo_metadata",
            "import_map_players",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "missing table {table}");
        }
    }

    #[test]
    fn parses_messagepack_with_the_same_root_format_detection() {
        let value = serde_json::json!({
            "version": 1,
            "updated_at": "now",
            "canonical_grenades": [{
                "map": "de_test",
                "throw_keys": "M1+JUMP",
                "thrower_steamid64": 76561198000000001u64,
                "tickrate": 128.5
            }]
        });
        let bytes = rmp_serde::to_vec(&value).unwrap();
        let TypedImportFile::GrenadeIndex(index) = parse_import_bytes(&bytes, true).unwrap() else {
            panic!("expected canonical MessagePack import");
        };
        assert_eq!(
            index.canonical_grenades[0].throw_keys.as_deref(),
            Some("M1+JUMP")
        );
        assert_eq!(
            index.canonical_grenades[0].thrower_steamid64.as_deref(),
            Some("76561198000000001")
        );
        assert_eq!(index.canonical_grenades[0].tickrate, Some(128.5));
        for extension in ["messagepack", "msgpack", "mpk"] {
            assert!(is_messagepack_path(Path::new(&format!(
                "library.{extension}"
            ))));
        }
        assert_eq!(
            serde_json::to_value(index.canonical_grenades[0].clone())
                .unwrap()
                .get("throw_keys")
                .and_then(Value::as_str),
            Some("M1+JUMP")
        );
    }

    #[test]
    fn parses_messagepack_file_without_building_a_byte_buffer() {
        let root = std::env::temp_dir().join(format!(
            "nade-viewer-messagepack-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("library.msgpack");
        let value = serde_json::json!({
            "version": 1,
            "canonical_grenades": [{"map": "de_test"}]
        });
        fs::write(&path, rmp_serde::to_vec(&value).unwrap()).unwrap();

        let parsed = parse_messagepack_file(&path).unwrap();
        assert!(matches!(parsed, TypedImportFile::GrenadeIndex(_)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_players_from_nested_demo_and_steamid_shapes() {
        let TypedImportFile::GrenadeIndex(index) = parse_import(
            br#"{
                "version": 1,
                "canonical_grenades": [],
                "players": {
                    "demo_a_2024-01-02.dem": {
                        "76561198000000001": {"name": "Alice", "team": "Alpha", "side": "T"}
                    }
                }
            }"#
            .as_slice(),
        )
        .unwrap() else {
            panic!("expected canonical import");
        };
        assert_eq!(index.players.len(), 1);
        assert_eq!(
            index.players[0].demo_filename.as_deref(),
            Some("demo_a_2024-01-02.dem")
        );
        assert_eq!(
            index.players[0].steamid64.as_deref(),
            Some("76561198000000001")
        );
        assert_eq!(index.players[0].player_name.as_deref(), Some("Alice"));
    }

    #[test]
    fn derives_metadata_from_unicode_demo_filenames() {
        assert_eq!(
            demo_date_from_filename("Кубок_match_2024-01-02.dem").map(|date| date.to_string()),
            Some("2024-01-02".to_string())
        );
        assert_eq!(
            demo_tournament_from_filename("Кубок_match_2024-01-02.dem").as_deref(),
            Some("Кубок")
        );
    }

    #[test]
    fn event_filters_match_canonical_or_usage_event_rows() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        insert_import(&conn, 1);
        conn.execute(
            "INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type)
             VALUES (10, 1, 0, 'de_test', 'T', 'smoke')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO grenade_usage_events(import_id, grenade_id, demo_filename, thrower_steamid64, thrower_team)
             VALUES (1, 10, 'Alpha_match_2024-01-02.dem', '76561198000000001', 'Team Alpha')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO demo_metadata(import_id, demo_filename, tournament, demo_date)
             VALUES (1, 'Alpha_match_2024-01-02.dem', 'Alpha', '2024-01-02')",
            [],
        )
        .unwrap();

        let filters = MapFilters {
            thrower_steamid64: Some("76561198000000001".to_string()),
            thrower_team: Some("alpha".to_string()),
            tournament: Some("Alpha".to_string()),
            ..Default::default()
        };
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let sql = format!(
            "SELECT g.id FROM grenades g WHERE 1=1{}",
            filter_sql(&filters, &mut args, "g")
        );
        let id: i64 = conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(args.iter().map(|arg| &**arg)),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(id, 10);
    }

    #[test]
    fn insta_filter_matches_grenades_started_at_spawn_points() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        insert_import(&conn, 1);
        conn.execute(
            "INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type, start_map_x, start_map_y)
             VALUES (10, 1, 0, 'de_test', 'T', 'smoke', 100.02, 200.01),
                    (11, 1, 1, 'de_test', 'T', 'smoke', 120.0, 220.0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spawn_points(map, side, pos_x, pos_y, pos_z, map_x, map_y)
             VALUES ('de_test', 'T', 0, 0, 0, 100.0, 200.0)",
            [],
        )
        .unwrap();

        let filters = MapFilters {
            is_insta: Some(true),
            ..Default::default()
        };
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let sql = format!(
            "SELECT g.id FROM grenades g WHERE g.import_id=1 AND g.map='de_test'{} ORDER BY g.id",
            filter_sql(&filters, &mut args, "g")
        );
        let ids = conn
            .prepare(&sql)
            .unwrap()
            .query_map(
                rusqlite::params_from_iter(args.iter().map(|arg| &**arg)),
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(ids, vec![10]);
    }

    #[test]
    fn usage_stats_aggregate_events_and_sort_history_by_demo_date() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        insert_import(&conn, 1);
        conn.execute(
            "INSERT INTO grenades(id, import_id, source_index, map, side, grenade_type, usage_count)
             VALUES (10, 1, 0, 'de_test', 'T', 'smoke', 99)",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO grenade_usage_events(import_id, grenade_id, demo_filename, throw_tick, thrower, thrower_team)
             VALUES (1, 10, 'Cup_match_2024-02-03.dem', 20, 'Alice', 'Alpha'),
                    (1, 10, 'Cup_match_2024-01-03.dem', 10, 'Bob', 'Beta'),
                    (1, 10, 'Cup_match_2024-02-03.dem', 30, 'Alice', 'Alpha'),
                    (1, 10, NULL, 40, 'Carol', 'Gamma');",
        )
        .unwrap();
        let stats = usage_stats_from_conn(
            &conn,
            10,
            UsageFallback {
                usage_count: 99,
                usage_throwers: &[],
                thrower: None,
                steamid64: None,
                team: None,
                demo: None,
                tick: None,
            },
        )
        .unwrap();
        assert_eq!(stats.tracked_throws, 4);
        assert_eq!(stats.peak, 2);
        assert_eq!(stats.most_used_player.as_deref(), Some("Alice"));
        assert_eq!(stats.most_used_player_throws, 2);
        assert_eq!(stats.most_used_team.as_deref(), Some("Alpha"));
        assert_eq!(stats.last_demo.as_deref(), Some("Cup_match_2024-02-03.dem"));
        assert_eq!(stats.last_tick, Some(30));
        assert_eq!(stats.history[0].label, "Cup_match_2024-01-03.dem");
        assert_eq!(stats.history[1].label, "Cup_match_2024-02-03.dem");
        assert_eq!(stats.history[2].label, "Unknown demo");
    }

    #[test]
    fn core_preview_only_trajectory_survives_canonical_round_trip() {
        let grenade = round_trip_core_trajectory(
            r#"{
                "version": 1,
                "exported_at": "then",
                "grenades": [{
                    "map": "Legacy",
                    "side": "T",
                    "grenade_type": "smoke",
                    "trajectory_preview": [[10.0, 20.0], [30.0, 40.0]]
                }]
            }"#,
        );

        assert_eq!(grenade.trajectory, None);
        assert_eq!(
            grenade.trajectory_preview,
            Some(serde_json::json!([[10.0, 20.0], [30.0, 40.0]]))
        );
    }

    #[test]
    fn core_full_trajectory_survives_canonical_round_trip_and_generates_preview() {
        let trajectory = vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]];
        let grenade = round_trip_core_trajectory(
            r#"{
                "version": 1,
                "exported_at": "then",
                "grenades": [{
                    "map": "Current",
                    "side": "CT",
                    "grenade_type": "flashbang",
                    "trajectory": [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
                }]
            }"#,
        );

        assert_eq!(grenade.trajectory, Some(trajectory));
        assert_eq!(
            grenade.trajectory_preview,
            Some(serde_json::json!([[1.0, 2.0], [4.0, 5.0]]))
        );
    }

    #[test]
    fn reports_top_level_format_and_version_errors() {
        let cases = [
            ("[]", "invalid_top_level"),
            (r#"{"other":[]}"#, "unsupported_format"),
            (
                r#"{"canonical_grenades":[],"grenades":[]}"#,
                "ambiguous_format",
            ),
            (r#"{"grenades":[],"exported_at":"now"}"#, "missing_version"),
            (
                r#"{"version":"1","canonical_grenades":[]}"#,
                "invalid_version",
            ),
            (
                r#"{"version":2,"canonical_grenades":[]}"#,
                "unsupported_version",
            ),
        ];

        for (json, expected_code) in cases {
            let error = parse_import(json.as_bytes()).err().unwrap();
            assert!(
                matches!(error, AppError::Import { code, .. } if code == expected_code),
                "expected {expected_code}, got {error}"
            );
        }
    }

    #[test]
    fn import_start_is_an_atomic_single_winner_operation() {
        use std::sync::Barrier;

        let status = Arc::new(Mutex::new(ImportStatus::default()));
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let status = Arc::clone(&status);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    try_begin_import(&status).is_ok()
                })
            })
            .collect();
        let winners = handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .filter(|won| *won)
            .count();

        assert_eq!(winners, 1);
        assert!(status.lock().unwrap().running);
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
                "SELECT g.source_index FROM grenades g WHERE 1=1{}",
                filter_sql(&filters, &mut args, "g")
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
    fn migrates_v040_throw_columns_and_accepts_a_new_import() {
        let (state, root) = temporary_test_state("v040-schema-migration");
        let conn = open_conn(&state).unwrap();
        conn.execute_batch(
            "CREATE TABLE imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_path TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                parser_version INTEGER,
                parser_updated_at TEXT,
                grenade_count INTEGER NOT NULL,
                map_count INTEGER NOT NULL
             );
             CREATE TABLE grenades (
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
                thrower_team TEXT,
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
             INSERT INTO imports(
                id, source_path, imported_at, parser_version, parser_updated_at,
                grenade_count, map_count
             ) VALUES (7, 'v0.4.0.json', 'then', 1, 'then', 1, 1);
             INSERT INTO grenades(
                id, import_id, source_index, map, side, grenade_type, throw_description
             ) VALUES (9, 7, 0, 'de_test', 'T', 'smoke', 'M1+JUMP');",
        )
        .unwrap();

        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT throw_keys FROM grenades WHERE id=9", [], |row| {
                row.get::<_, String>(0)
            },)
                .unwrap(),
            "M1+JUMP"
        );
        let columns = table_columns(&conn, "grenades").unwrap();
        assert!(columns.contains("throw_keys"));
        assert!(columns.contains("thrower_steamid64"));
        drop(conn);

        let TypedImportFile::GrenadeIndex(index) = parse_import(
            br#"{
                "version": 1,
                "canonical_grenades": [{
                    "map": "de_test",
                    "throw_keys": "M2",
                    "thrower_steamid64": "76561198000000001"
                }]
            }"#
            .as_slice(),
        )
        .unwrap() else {
            panic!("expected canonical import");
        };
        let report = import_index_blocking(&state, "new.json", index, None).unwrap();
        let conn = open_conn(&state).unwrap();
        let imported: (String, String) = conn
            .query_row(
                "SELECT throw_keys, thrower_steamid64 FROM grenades WHERE import_id=?1",
                params![report.import_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            imported,
            ("M2".to_string(), "76561198000000001".to_string())
        );
        drop(conn);
        fs::remove_dir_all(root).unwrap();
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
            conn.execute(
                "INSERT INTO grenade_usage_events(import_id, grenade_id, demo_filename)
                 VALUES (?1, ?2, ?3)",
                params![id, id * 10, format!("Cup_match_2024-01-0{id}.dem")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO import_players(import_id, demo_filename, steamid64, player_name)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    id,
                    format!("Cup_match_2024-01-0{id}.dem"),
                    format!("steam-{id}"),
                    format!("Player {id}")
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO demo_metadata(import_id, demo_filename, tournament, demo_date)
                 VALUES (?1, ?2, 'Cup', ?3)",
                params![
                    id,
                    format!("Cup_match_2024-01-0{id}.dem"),
                    format!("2024-01-0{id}")
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO import_map_players(import_id, map, tournament, steamid64, player_name)
                 VALUES (?1, 'de_test', 'Cup', ?2, ?3)",
                params![id, format!("steam-{id}"), format!("Player {id}")],
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
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_usage_events"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM import_players"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM demo_metadata"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM import_map_players"), 2);
        assert_eq!(
            delete_import_from_conn(&mut conn, 2).unwrap().unwrap().id,
            3
        );
        assert_eq!(active_import_id(&conn).unwrap(), Some(3));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_view_history"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_usage_events"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM import_players"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM demo_metadata"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM import_map_players"), 1);
        assert!(delete_import_from_conn(&mut conn, 3).unwrap().is_none());
        assert_eq!(active_import_id(&conn).unwrap(), None);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_view_history"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM grenade_usage_events"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM import_players"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM demo_metadata"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM import_map_players"), 0);
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
