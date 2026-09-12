use crate::parser_store;
use serde::Serialize;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
pub(crate) struct PluginInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}
#[derive(Serialize, Clone, Default)]
pub(crate) struct ParserStatus {
    pub running: bool,
    pub stage: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub completed: usize,
    pub total: usize,
    pub current: Option<String>,
}
fn exe(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_default()
        .join("plugins/nade-parser")
        .join(if cfg!(windows) {
            "nade-parser.exe"
        } else {
            "nade-parser"
        })
}
fn state(app: &AppHandle) -> Arc<Mutex<ParserStatus>> {
    app.state::<Arc<Mutex<ParserStatus>>>().inner().clone()
}

fn parser_supports_stdout(executable: &Path) -> bool {
    Command::new(executable)
        .arg("--plugin-info")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
        .and_then(|info| info.get("protocol_version")?.as_u64())
        .is_some_and(|version| version >= 2)
}
#[tauri::command]
pub(crate) fn get_nade_parser_info(app: AppHandle) -> PluginInfo {
    let p = exe(&app);
    let version = Command::new(&p)
        .arg("--plugin-info")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
        .and_then(|v| v.get("version")?.as_str().map(str::to_owned));
    PluginInfo {
        installed: p.is_file(),
        path: p.is_file().then(|| p.display().to_string()),
        version,
    }
}
#[tauri::command]
pub(crate) fn get_nade_parser_status(app: AppHandle) -> ParserStatus {
    state(&app).lock().unwrap().clone()
}
#[tauri::command]
pub(crate) fn select_demo_files() -> Vec<String> {
    rfd::FileDialog::new()
        .add_filter("Demo", &["dem"])
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}
#[tauri::command]
pub(crate) fn select_demo_folders() -> Vec<String> {
    rfd::FileDialog::new()
        .pick_folders()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}
#[tauri::command]
pub(crate) fn install_nade_parser(app: AppHandle) -> Result<PluginInfo, String> {
    if state(&app).lock().unwrap().running {
        return Err("A parser job is already running".into());
    }
    let source = rfd::FileDialog::new()
        .add_filter("Executable", &["exe"])
        .pick_file()
        .ok_or("Installation cancelled")?;
    let p = exe(&app);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::copy(source, p).map_err(|e| e.to_string())?;
    let info = get_nade_parser_info(app);
    if info.version.is_none() {
        return Err("Selected executable is not a compatible Nade Parser plugin".into());
    }
    Ok(info)
}

fn discover_demos(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("Select at least one demo or folder".into());
    }
    let mut pending = Vec::new();
    for input in paths {
        let p = std::fs::canonicalize(input).map_err(|e| format!("{input}: {e}"))?;
        if !p.is_dir() && !is_demo(&p) {
            return Err(format!("Not a .dem file or folder: {input}"));
        }
        pending.push(p);
    }
    let mut visited = BTreeSet::new();
    let mut files = BTreeSet::new();
    while let Some(p) = pending.pop() {
        let p = p
            .canonicalize()
            .map_err(|e| format!("{}: {e}", p.display()))?;
        if !visited.insert(p.clone()) {
            continue;
        }
        if p.is_dir() {
            for entry in std::fs::read_dir(&p).map_err(|e| format!("{}: {e}", p.display()))? {
                let entry = entry.map_err(|e| format!("{}: {e}", p.display()))?;
                pending.push(entry.path());
            }
        } else if p.is_file() && is_demo(&p) {
            files.insert(p);
        }
    }
    if files.is_empty() {
        return Err("No .dem files found in the selected paths".into());
    }
    Ok(files.into_iter().collect())
}
fn is_demo(p: &Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("dem"))
}

fn workspace_connection(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let db = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("parser-workspace.sqlite");
    parser_store::open(&db).map_err(|e| e.to_string())
}

fn ensure_dataset_ready(c: &rusqlite::Connection, canonical: bool) -> Result<(), String> {
    let (raw, _) = parser_store::counts(c).map_err(|e| e.to_string())?;
    if raw == 0 {
        return Err("Parser workspace is empty. Parse demos first.".into());
    }
    if canonical && parser_store::canonical_count(c).map_err(|e| e.to_string())? == 0 {
        return Err("Canonical set is empty. Recompute deduplication first.".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn run_nade_parser(
    app: AppHandle,
    demo_path: String,
    deduplicate: bool,
) -> Result<(), String> {
    run_nade_parser_batch(app, vec![demo_path], deduplicate)
}
#[tauri::command]
pub(crate) fn run_nade_parser_batch(
    app: AppHandle,
    paths: Vec<String>,
    deduplicate: bool,
) -> Result<(), String> {
    let executable = exe(&app);
    if !executable.is_file() {
        return Err("Nade Parser plugin is not installed".into());
    }
    let s = state(&app);
    {
        let mut x = s.lock().unwrap();
        if x.running {
            return Err("A parser job is already running".into());
        }
        x.running = true;
        x.stage = "scanning".into();
        x.error = None;
        x.completed = 0;
        x.total = 0;
        x.current = None;
    }
    let worker_state = s.clone();
    let stdout_protocol = parser_supports_stdout(&executable);
    let workspace_path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("parser-workspace.sqlite");
    let spawn = std::thread::Builder::new().spawn(move || {
        let result = (|| -> Result<PathBuf, String> {
            let files = discover_demos(&paths)?;
            {
                let mut x = worker_state.lock().unwrap();
                x.total = files.len();
                x.stage = "parsing".into();
            }
            let mut store = parser_store::open(&workspace_path).map_err(|e| e.to_string())?;
            let legacy_output = workspace_path.with_file_name("nade-parser-output.json");
            if !stdout_protocol {
                let _ = std::fs::remove_file(&legacy_output);
            }
            for file in files {
                worker_state.lock().unwrap().current = Some(file.display().to_string());
                let (size, modified) =
                    parser_store::fingerprint(&file).map_err(|e| e.to_string())?;
                if parser_store::unchanged(&store, &file.display().to_string(), size, modified)
                    .map_err(|e| e.to_string())?
                {
                    worker_state.lock().unwrap().completed += 1;
                    continue;
                }
                let output_target = if stdout_protocol {
                    Path::new("-")
                } else {
                    legacy_output.as_path()
                };
                let result = Command::new(&executable)
                    .arg("--parse")
                    .arg("--demo")
                    .arg(&file)
                    .arg("--output")
                    .arg(output_target)
                    .output()
                    .map_err(|e| format!("{}: {e}", file.display()))?;
                if !result.status.success() {
                    return Err(format!(
                        "{}: {}\n{}",
                        file.display(),
                        result.status,
                        String::from_utf8_lossy(&result.stderr).trim()
                    ));
                }
                let output = if stdout_protocol {
                    result.stdout
                } else {
                    let bytes = std::fs::read(&legacy_output)
                        .map_err(|e| format!("{}: output: {e}", file.display()))?;
                    std::fs::remove_file(&legacy_output).map_err(|e| e.to_string())?;
                    bytes
                };
                let next: serde_json::Value = serde_json::from_slice(&output)
                    .map_err(|e| format!("{}: invalid output: {e}", file.display()))?;
                let items = next
                    .get("canonical_grenades")
                    .and_then(|v| v.as_array())
                    .ok_or("Plugin output has no canonical_grenades array")?;
                parser_store::import_demo(
                    &mut store,
                    &file.display().to_string(),
                    size,
                    modified,
                    items,
                )
                .map_err(|e| e.to_string())?;
                worker_state.lock().unwrap().completed += 1;
            }
            worker_state.lock().unwrap().stage = "finalizing".into();
            if deduplicate {
                let items = parser_store::all(&store).map_err(|e| e.to_string())?;
                let canonical = crate::dedup::deduplicate(items);
                parser_store::replace_canonical(&mut store, &canonical)
                    .map_err(|e| e.to_string())?;
            }
            Ok(workspace_path.clone())
        })();
        let mut x = worker_state.lock().unwrap();
        x.running = false;
        x.current = None;
        match result {
            Ok(out) => {
                x.stage = "complete".into();
                x.output = Some(out.display().to_string());
            }
            Err(e) => {
                x.stage = "failed".into();
                x.error = Some(e);
            }
        }
    });
    if let Err(e) = spawn {
        let mut x = s.lock().unwrap();
        x.running = false;
        x.stage = "failed".into();
        x.error = Some(e.to_string());
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn deduplicate_parser_workspace(app: AppHandle) -> Result<(), String> {
    let mut c = workspace_connection(&app)?;
    let out = crate::dedup::deduplicate(parser_store::all(&c).map_err(|e| e.to_string())?);
    parser_store::replace_canonical(&mut c, &out).map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn get_parser_workspace_counts(app: AppHandle) -> Result<(i64, i64), String> {
    parser_store::counts(&workspace_connection(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn clear_parser_workspace(app: AppHandle) -> Result<(), String> {
    if state(&app).lock().unwrap().running {
        return Err("Cannot clear the parser workspace while parsing is running".into());
    }

    let mut connection = workspace_connection(&app)?;
    parser_store::clear(&mut connection).map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn save_parser_output(
    app: AppHandle,
    source: String,
    format: String,
) -> Result<Option<String>, String> {
    let canonical = source == "canonical";
    let c = workspace_connection(&app)?;
    ensure_dataset_ready(&c, canonical)?;
    let is_msgpack = format == "msgpack";
    let dialog = rfd::FileDialog::new().add_filter(
        if is_msgpack {
            "MessagePack library"
        } else {
            "JSON library"
        },
        &[if is_msgpack { "msgpack" } else { "json" }],
    );
    let Some(path) = dialog
        .set_file_name(if is_msgpack {
            "nade-parser.msgpack"
        } else {
            "nade-parser.json"
        })
        .save_file()
    else {
        return Ok(None);
    };
    if is_msgpack {
        parser_store::write_msgpack(&c, canonical, &path).map_err(|e| e.to_string())?;
    } else {
        parser_store::write_json(&c, canonical, &path).map_err(|e| e.to_string())?;
    }
    Ok(Some(path.display().to_string()))
}
#[tauri::command]
pub(crate) fn prepare_parser_import(app: AppHandle, source: String) -> Result<String, String> {
    let canonical = source == "canonical";
    let c = workspace_connection(&app)?;
    ensure_dataset_ready(&c, canonical)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("parser-import");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("parser-import.json");
    parser_store::write_json(&c, canonical, &path).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_nested_overlap_and_validation() {
        let dir = std::env::temp_dir().join(format!(
            "nade-discovery-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("nested/empty")).unwrap();
        for file in ["a.dem", "nested/b.DEM", "nested/notes.txt"] {
            std::fs::write(dir.join(file), b"").unwrap();
        }
        let paths = vec![
            dir.display().to_string(),
            dir.join("nested").display().to_string(),
            dir.join("a.dem").display().to_string(),
        ];
        let files = discover_demos(&paths).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0] < files[1]);
        assert!(discover_demos(&[dir.join("nested/empty").display().to_string()]).is_err());
        assert!(discover_demos(&[dir.join("nested/notes.txt").display().to_string()]).is_err());
        assert!(discover_demos(&[dir.join("missing").display().to_string()]).is_err());
        assert!(discover_demos(&[]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
