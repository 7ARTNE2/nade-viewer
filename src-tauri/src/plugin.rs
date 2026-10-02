use crate::parser_store;
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

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
    pub elapsed_ms: u64,
    pub workers: usize,
    pub worker_mode: String,
    pub active_parsers: usize,
    pub disk_read_bytes_per_sec: u64,
    pub disk_write_bytes_per_sec: u64,
    #[serde(skip)]
    started_at: Option<Instant>,
    #[serde(skip)]
    last_io_sample: Option<(Instant, u64, u64)>,
}

impl ParserStatus {
    fn start(&mut self, stage: &str) {
        self.running = true;
        self.stage = stage.into();
        self.output = None;
        self.error = None;
        self.completed = 0;
        self.total = 0;
        self.current = None;
        self.elapsed_ms = 0;
        self.active_parsers = 0;
        self.worker_mode.clear();
        self.disk_read_bytes_per_sec = 0;
        self.disk_write_bytes_per_sec = 0;
        self.started_at = Some(Instant::now());
        self.last_io_sample = None;
    }

    fn update_elapsed(&mut self) {
        if let Some(started_at) = self.started_at.as_ref() {
            self.elapsed_ms = started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        }
    }

    fn update_io_rate(&mut self, pids: &[u32]) {
        let now = Instant::now();
        let (read_bytes, write_bytes) = process_io_bytes(pids);
        if let Some((sampled_at, previous_read, previous_write)) = self.last_io_sample {
            let elapsed = now.duration_since(sampled_at).as_secs_f64();
            if elapsed > 0.0 {
                self.disk_read_bytes_per_sec =
                    (read_bytes.saturating_sub(previous_read) as f64 / elapsed) as u64;
                self.disk_write_bytes_per_sec =
                    (write_bytes.saturating_sub(previous_write) as f64 / elapsed) as u64;
            }
        }
        self.last_io_sample = Some((now, read_bytes, write_bytes));
    }

    fn finish(&mut self, result: Result<Option<PathBuf>, String>) {
        self.update_elapsed();
        self.started_at = None;
        self.running = false;
        self.active_parsers = 0;
        self.current = None;
        match result {
            Ok(output) => {
                self.stage = "complete".into();
                self.output = output.map(|path| path.display().to_string());
                self.error = None;
            }
            Err(error) => {
                self.stage = "failed".into();
                self.error = Some(error);
            }
        }
    }
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

#[derive(Default)]
pub(crate) struct ParserControl {
    cancel: AtomicBool,
    children: Mutex<Vec<u32>>,
}

fn control(app: &AppHandle) -> Arc<ParserControl> {
    app.state::<Arc<ParserControl>>().inner().clone()
}

#[cfg(windows)]
fn process_io_bytes(pids: &[u32]) -> (u64, u64) {
    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    unsafe extern "system" {
        fn OpenProcess(
            desired_access: u32,
            inherit_handle: i32,
            process_id: u32,
        ) -> *mut std::ffi::c_void;
        fn GetProcessIoCounters(handle: *mut std::ffi::c_void, counters: *mut IoCounters) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let mut read_bytes = 0;
    let mut write_bytes = 0;
    for pid in pids {
        // Child processes may exit between sampling and opening their handle.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid) };
        if handle.is_null() {
            continue;
        }
        let mut counters = std::mem::MaybeUninit::<IoCounters>::uninit();
        if unsafe { GetProcessIoCounters(handle, counters.as_mut_ptr()) } != 0 {
            let counters = unsafe { counters.assume_init() };
            read_bytes += counters.read_transfer_count;
            write_bytes += counters.write_transfer_count;
        }
        unsafe { CloseHandle(handle) };
    }
    (read_bytes, write_bytes)
}

#[cfg(not(windows))]
fn process_io_bytes(_: &[u32]) -> (u64, u64) {
    (0, 0)
}

impl ParserControl {
    fn reset(&self) {
        self.cancel.store(false, Ordering::Release);
        self.children.lock().unwrap().clear();
    }

    fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
        let children = self.children.lock().unwrap().clone();
        for pid in children {
            terminate_process(pid);
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn register(&self, pid: u32) {
        self.children.lock().unwrap().push(pid);
    }

    fn unregister(&self, pid: u32) {
        self.children.lock().unwrap().retain(|child| *child != pid);
    }
}

fn terminate_process(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn parser_supports_stdout(executable: &Path) -> bool {
    let mut command = Command::new(executable);
    hide_console(&mut command)
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
    let mut command = Command::new(&p);
    let version = hide_console(&mut command)
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
    let parser_control = control(&app);
    let parser_state = state(&app);
    let mut status = parser_state.lock().unwrap();
    if status.running {
        status.update_elapsed();
        let children = parser_control.children.lock().unwrap();
        status.active_parsers = children.len();
        status.update_io_rate(&children);
    }
    status.clone()
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

fn remove_nade_parser(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("Nade Parser plugin is not installed".into());
    }
    std::fs::remove_file(path).map_err(|e| format!("Could not remove Nade Parser plugin: {e}"))?;

    if let Some(directory) = path.parent() {
        if let Err(error) = std::fs::remove_dir(directory) {
            if error.kind() != std::io::ErrorKind::NotFound
                && error.kind() != std::io::ErrorKind::DirectoryNotEmpty
            {
                return Err(format!(
                    "Plugin was removed, but its directory could not be cleaned up: {error}"
                ));
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn uninstall_nade_parser(app: AppHandle) -> Result<(), String> {
    if state(&app).lock().unwrap().running {
        return Err("Cannot remove the plugin while parsing is running".into());
    }
    remove_nade_parser(&exe(&app))
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

const AUTO_SSD_WORKERS: usize = 5;
const MAX_PARSER_WORKERS: usize = 8;

#[derive(Clone)]
struct ParseJob {
    ordinal: usize,
    file: PathBuf,
    size: u64,
    modified: i64,
    disk: DiskGroup,
}

struct ParseJobResult {
    job: ParseJob,
    output_path: PathBuf,
    stderr_path: PathBuf,
    result: Result<(), String>,
}

fn bounded_worker_count(configured: usize, available: usize, job_count: usize) -> usize {
    configured
        .clamp(1, MAX_PARSER_WORKERS)
        .min(available.max(1))
        .min(job_count.max(1))
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct DiskGroup {
    key: String,
    limit: usize,
}

// A conservative unknown group never causes competing reads from an unidentified device.
fn disk_group(path: &Path) -> DiskGroup {
    #[cfg(windows)]
    {
        if let Some(group) = windows_disk_group(path) {
            return group;
        }
    }
    let _ = path;
    DiskGroup {
        key: "unknown".into(),
        limit: 1,
    }
}

#[cfg(windows)]
fn volume_drive_letter(path: &Path) -> Option<u8> {
    // canonicalize() returns verbatim Windows paths (\\?\F:\...), not F:\...
    let path = path.to_str()?;
    let path = path.strip_prefix("\\\\?\\").unwrap_or(path);
    let bytes = path.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || bytes[2] != b'\\' {
        return None;
    }
    let letter = bytes[0].to_ascii_uppercase();
    letter.is_ascii_alphabetic().then_some(letter)
}

#[cfg(windows)]
fn windows_disk_group(path: &Path) -> Option<DiskGroup> {
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut std::ffi::c_void,
            creation: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
        fn DeviceIoControl(
            handle: *mut std::ffi::c_void,
            control: u32,
            input: *const u8,
            input_len: u32,
            output: *mut u8,
            output_len: u32,
            returned: *mut u32,
            overlapped: *mut std::ffi::c_void,
        ) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    struct Handle(*mut std::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn open(name: &str) -> Option<Handle> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0,
                3,
                std::ptr::null_mut(),
                3,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == -1 || handle.is_null() {
            None
        } else {
            Some(Handle(handle))
        }
    }
    fn ioctl(handle: &Handle, code: u32, input: &[u8], output: &mut [u8]) -> Option<usize> {
        let mut returned = 0;
        let ok = unsafe {
            DeviceIoControl(
                handle.0,
                code,
                input.as_ptr(),
                input.len() as u32,
                output.as_mut_ptr(),
                output.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(returned as usize)
    }
    let letter = volume_drive_letter(path)?;
    let volume = open(&format!(r"\\.\{}:", letter as char))?;
    let mut extents = [0u8; 4096];
    let len = ioctl(&volume, 0x00560000, &[], &mut extents)?;
    if len < 32 {
        return None;
    }
    let count = u32::from_ne_bytes(extents[0..4].try_into().ok()?) as usize;
    if count != 1 || count > (len - 8) / 24 {
        return None;
    }
    let mut disks = Vec::with_capacity(count);
    let mut seek = false;
    for i in 0..count {
        let offset = 8 + i * 24;
        let id = u32::from_ne_bytes(extents[offset..offset + 4].try_into().ok()?);
        let physical = open(&format!(r"\\.\PhysicalDrive{id}"))?;
        let mut descriptor = [0u8; 16];
        // STORAGE_PROPERTY_QUERY: StorageDeviceSeekPenaltyProperty (7), PropertyStandardQuery (0).
        let result = ioctl(
            &physical,
            0x002d1400,
            &[7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            &mut descriptor,
        )?;
        if result < 9 || u32::from_ne_bytes(descriptor[4..8].try_into().ok()?) < 9 {
            return None;
        }
        seek |= descriptor[8] != 0;
        disks.push(id);
    }
    disks.sort_unstable();
    disks.dedup();
    Some(DiskGroup {
        key: format!("physical:{disks:?}"),
        limit: if seek { 1 } else { AUTO_SSD_WORKERS },
    })
}

fn parser_worker_count(requested: Option<usize>, jobs: &[ParseJob]) -> usize {
    let configured = requested.unwrap_or_else(|| {
        jobs.iter()
            .map(|job| (&job.disk.key, job.disk.limit))
            .collect::<HashMap<_, _>>()
            .into_values()
            .sum::<usize>()
            .min(MAX_PARSER_WORKERS)
    });
    let available = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    bounded_worker_count(configured, available, jobs.len())
}

fn next_scheduled_job(
    jobs: &[ParseJob],
    sent: &[bool],
    active: &HashMap<String, usize>,
    automatic: bool,
) -> Option<usize> {
    jobs.iter().enumerate().position(|(index, job)| {
        !sent[index]
            && (!automatic || active.get(&job.disk.key).copied().unwrap_or(0) < job.disk.limit)
    })
}

fn spool_path(workspace_path: &Path, ordinal: usize, suffix: &str) -> PathBuf {
    workspace_path.with_file_name(format!(
        ".nade-parser-{}-{ordinal}.{suffix}",
        std::process::id()
    ))
}

fn remove_spool_file(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "Could not remove parser spool file '{}': {error}",
                path.display()
            );
        }
    }
}

fn run_parser_job(
    executable: &Path,
    workspace_path: &Path,
    stdout_protocol: bool,
    control: &ParserControl,
    job: ParseJob,
) -> ParseJobResult {
    let output_path = spool_path(workspace_path, job.ordinal, "json");
    let stderr_path = spool_path(workspace_path, job.ordinal, "stderr");
    remove_spool_file(&output_path);
    remove_spool_file(&stderr_path);

    let result = (|| -> Result<(), String> {
        if control.is_cancelled() {
            return Err("Parsing cancelled".into());
        }
        let stderr = File::create(&stderr_path)
            .map_err(|error| format!("{}: stderr: {error}", job.file.display()))?;
        let mut command = Command::new(executable);
        hide_console(&mut command)
            .arg("--parse")
            .arg("--demo")
            .arg(&job.file)
            .arg("--output")
            .arg(if stdout_protocol {
                Path::new("-")
            } else {
                output_path.as_path()
            })
            .stderr(Stdio::from(stderr));

        if stdout_protocol {
            let stdout = File::create(&output_path)
                .map_err(|error| format!("{}: output: {error}", job.file.display()))?;
            command.stdout(Stdio::from(stdout));
        } else {
            command.stdout(Stdio::null());
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("{}: {error}", job.file.display()))?;
        let pid = child.id();
        control.register(pid);
        if control.is_cancelled() {
            terminate_process(pid);
        }
        let status = child
            .wait()
            .map_err(|error| format!("{}: {error}", job.file.display()));
        control.unregister(pid);
        let status = status?;
        if control.is_cancelled() {
            return Err("Parsing cancelled".into());
        }
        if status.success() {
            return Ok(());
        }

        let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
        Err(format!(
            "{}: {}\n{}",
            job.file.display(),
            status,
            stderr.trim()
        ))
    })();

    ParseJobResult {
        job,
        output_path,
        stderr_path,
        result,
    }
}

fn cleanup_parse_result(result: &ParseJobResult) {
    remove_spool_file(&result.output_path);
    remove_spool_file(&result.stderr_path);
}

fn cleanup_stale_spool_files(workspace_path: &Path) {
    let Some(directory) = workspace_path.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(24 * 60 * 60))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with(".nade-parser-")
            || !(name.ends_with(".json") || name.ends_with(".stderr"))
        {
            continue;
        }
        let is_stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map(|modified| modified < cutoff)
            .unwrap_or(false);
        if is_stale {
            remove_spool_file(&path);
        }
    }
}

fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("parser-workspace.sqlite"))
}

pub(crate) fn workspace_connection(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    parser_store::open(&workspace_path(app)?).map_err(|e| e.to_string())
}

pub(crate) fn ensure_dataset_ready(
    c: &rusqlite::Connection,
    canonical: bool,
) -> Result<(), String> {
    let (raw, _, _) = parser_store::counts(c).map_err(|e| e.to_string())?;
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
    workers: Option<usize>,
) -> Result<(), String> {
    run_nade_parser_batch(app, vec![demo_path], deduplicate, workers)
}
#[tauri::command]
pub(crate) fn run_nade_parser_batch(
    app: AppHandle,
    paths: Vec<String>,
    deduplicate: bool,
    workers: Option<usize>,
) -> Result<(), String> {
    let executable = exe(&app);
    if !executable.is_file() {
        return Err("Nade Parser plugin is not installed".into());
    }
    let stdout_protocol = parser_supports_stdout(&executable);
    if workers.is_some_and(|workers| !(1..=MAX_PARSER_WORKERS).contains(&workers)) {
        return Err(format!(
            "Worker count must be between 1 and {MAX_PARSER_WORKERS}"
        ));
    }
    let workspace_path = workspace_path(&app)?;
    let s = state(&app);
    let parser_control = control(&app);
    {
        let mut status = s.lock().unwrap();
        if status.running {
            return Err("A parser job is already running".into());
        }
        parser_control.reset();
        status.start("scanning");
        status.workers = workers.unwrap_or(0);
        status.worker_mode = if workers.is_some() { "manual" } else { "auto" }.into();
    }
    let worker_state = s.clone();
    let worker_control = parser_control.clone();
    let spawn = std::thread::Builder::new().spawn(move || {
        let result = (|| -> Result<PathBuf, String> {
            let files = discover_demos(&paths)?;
            if worker_control.is_cancelled() {
                return Err("Parsing cancelled".into());
            }
            {
                let mut x = worker_state.lock().unwrap();
                x.total = files.len();
                x.stage = "parsing".into();
            }
            cleanup_stale_spool_files(&workspace_path);
            let mut store = parser_store::open(&workspace_path).map_err(|e| e.to_string())?;
            let mut jobs = Vec::new();
            let mut disk_groups = HashMap::new();
            let mut cached_ordinals = BTreeSet::new();
            for (ordinal, file) in files.into_iter().enumerate() {
                let (size, modified) =
                    parser_store::fingerprint(&file).map_err(|e| e.to_string())?;
                if parser_store::unchanged(&store, &file.display().to_string(), size, modified)
                    .map_err(|e| e.to_string())?
                {
                    cached_ordinals.insert(ordinal);
                } else {
                    #[cfg(windows)]
                    let root = volume_drive_letter(&file);
                    #[cfg(not(windows))]
                    let root = file
                        .components()
                        .next()
                        .map(|component| component.as_os_str().to_os_string());
                    let group = disk_groups
                        .entry(root)
                        .or_insert_with(|| disk_group(&file))
                        .clone();
                    jobs.push(ParseJob {
                        ordinal,
                        disk: group,
                        file,
                        size,
                        modified,
                    });
                }
            }

            let worker_count = parser_worker_count(workers, &jobs);
            worker_state.lock().unwrap().workers = worker_count;
            let (job_sender, job_receiver) = std::sync::mpsc::sync_channel(worker_count);
            let job_receiver = Arc::new(Mutex::new(job_receiver));
            let (result_sender, result_receiver) = std::sync::mpsc::sync_channel(worker_count);
            let mut sent = vec![false; jobs.len()];
            let mut sent_count = 0usize;
            let mut active_disks: HashMap<String, usize> = HashMap::new();
            let mut next_commit = 0usize;
            let mut in_flight = 0usize;
            let mut completed_ordinals = cached_ordinals.clone();
            while completed_ordinals.remove(&next_commit) {
                next_commit += 1;
            }
            worker_state.lock().unwrap().completed = next_commit;

            std::thread::scope(|scope| -> Result<(), String> {
                for _ in 0..worker_count {
                    let executable = executable.as_path();
                    let workspace_path = workspace_path.as_path();
                    let job_receiver = job_receiver.clone();
                    let result_sender = result_sender.clone();
                    let worker_control = worker_control.clone();
                    scope.spawn(move || loop {
                        let job = {
                            let receiver = job_receiver.lock().unwrap();
                            receiver.recv()
                        };
                        let Ok(job) = job else {
                            break;
                        };
                        if result_sender
                            .send(run_parser_job(
                                executable,
                                workspace_path,
                                stdout_protocol,
                                &worker_control,
                                job,
                            ))
                            .is_err()
                        {
                            break;
                        }
                    });
                }
                drop(result_sender);

                let mut failure = None;
                'coordinator: while sent_count < jobs.len() || in_flight > 0 {
                    if worker_control.is_cancelled() {
                        failure = Some("Parsing cancelled".into());
                        break;
                    }
                    while in_flight < worker_count {
                        let Some(index) =
                            next_scheduled_job(&jobs, &sent, &active_disks, workers.is_none())
                        else {
                            break;
                        };
                        if worker_control.is_cancelled() {
                            failure = Some("Parsing cancelled".into());
                            break 'coordinator;
                        }
                        if let Err(error) = job_sender.send(jobs[index].clone()) {
                            failure = Some(error.to_string());
                            break 'coordinator;
                        }
                        sent[index] = true;
                        sent_count += 1;
                        *active_disks
                            .entry(jobs[index].disk.key.clone())
                            .or_default() += 1;
                        in_flight += 1;
                    }

                    let result = match result_receiver.recv() {
                        Ok(result) => result,
                        Err(error) => {
                            failure = Some(error.to_string());
                            break;
                        }
                    };
                    in_flight -= 1;
                    if let Some(count) = active_disks.get_mut(&result.job.disk.key) {
                        *count -= 1;
                    }
                    worker_state.lock().unwrap().current =
                        Some(result.job.file.display().to_string());
                    if let Err(error) = &result.result {
                        failure = Some(error.clone());
                        cleanup_parse_result(&result);
                        break 'coordinator;
                    }
                    let import_result = parser_store::import_demo_file(
                        &mut store,
                        &result.job.file.display().to_string(),
                        result.job.size,
                        result.job.modified,
                        &result.output_path,
                    )
                    .map_err(|error| {
                        format!("{}: invalid output: {error}", result.job.file.display())
                    });
                    cleanup_parse_result(&result);
                    if let Err(error) = import_result {
                        failure = Some(error);
                        break 'coordinator;
                    }
                    completed_ordinals.insert(result.job.ordinal);
                    while completed_ordinals.remove(&next_commit) {
                        next_commit += 1;
                    }
                    worker_state.lock().unwrap().completed = next_commit;
                }

                drop(job_sender);
                for result in result_receiver {
                    cleanup_parse_result(&result);
                }
                if let Some(error) = failure {
                    Err(error)
                } else {
                    Ok(())
                }
            })?;

            if worker_control.is_cancelled() {
                return Err("Parsing cancelled".into());
            }
            if next_commit < worker_state.lock().unwrap().total {
                return Err("Parser results ended before every demo was committed".into());
            }
            worker_state.lock().unwrap().completed = next_commit;
            if deduplicate {
                if worker_control.is_cancelled() {
                    return Err("Parsing cancelled".into());
                }
                {
                    let mut status = worker_state.lock().unwrap();
                    status.stage = "deduplicating".into();
                    status.current = None;
                }
                let items = parser_store::all(&store).map_err(|e| e.to_string())?;
                let canonical = crate::dedup::deduplicate(items);
                worker_state.lock().unwrap().stage = "finalizing".into();
                parser_store::replace_canonical(&mut store, &canonical)
                    .map_err(|e| e.to_string())?;
            } else {
                worker_state.lock().unwrap().stage = "finalizing".into();
            }
            Ok(workspace_path.clone())
        })();
        let mut status = worker_state.lock().unwrap();
        if worker_control.is_cancelled() {
            status.update_elapsed();
            status.started_at = None;
            status.running = false;
            status.active_parsers = 0;
            status.current = None;
            status.stage = "cancelled".into();
            status.error = None;
            status.output = None;
        } else {
            status.finish(result.map(Some));
        }
    });
    if let Err(error) = spawn {
        let message = error.to_string();
        s.lock().unwrap().finish(Err(message.clone()));
        return Err(message);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn stop_nade_parser(app: AppHandle) -> Result<(), String> {
    let status = state(&app);
    if !status.lock().unwrap().running {
        return Err("No parser job is running".into());
    }
    {
        let mut status = status.lock().unwrap();
        status.stage = "cancelling".into();
        status.current = None;
    }
    control(&app).cancel();
    Ok(())
}

#[tauri::command]
pub(crate) fn deduplicate_parser_workspace(app: AppHandle) -> Result<(), String> {
    let workspace_path = workspace_path(&app)?;
    let s = state(&app);
    {
        let mut status = s.lock().unwrap();
        if status.running {
            return Err("A parser job is already running".into());
        }
        status.start("deduplicating");
    }

    let worker_state = s.clone();
    let spawn = std::thread::Builder::new().spawn(move || {
        let result = (|| -> Result<(), String> {
            let mut connection = parser_store::open(&workspace_path).map_err(|e| e.to_string())?;
            let items = parser_store::all(&connection).map_err(|e| e.to_string())?;
            let canonical = crate::dedup::deduplicate(items);
            worker_state.lock().unwrap().stage = "finalizing".into();
            parser_store::replace_canonical(&mut connection, &canonical).map_err(|e| e.to_string())
        })();
        worker_state.lock().unwrap().finish(result.map(|_| None));
    });
    if let Err(error) = spawn {
        let message = error.to_string();
        s.lock().unwrap().finish(Err(message.clone()));
        return Err(message);
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn get_parser_workspace_counts(app: AppHandle) -> Result<(i64, i64, i64), String> {
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
    use std::time::Duration;

    #[test]
    fn worker_count_defaults_to_four_and_stays_bounded() {
        assert_eq!(bounded_worker_count(4, 16, 100), 4);
        assert_eq!(bounded_worker_count(4, 2, 100), 2);
        assert_eq!(bounded_worker_count(4, 16, 3), 3);
        assert_eq!(bounded_worker_count(0, 16, 100), 1);
        assert_eq!(bounded_worker_count(99, 16, 100), MAX_PARSER_WORKERS);
        assert_eq!(bounded_worker_count(4, 16, 0), 1);
    }

    #[test]
    fn automatic_scheduler_respects_per_disk_limits() {
        let make = |ordinal: usize, key: &str, limit: usize| ParseJob {
            ordinal,
            file: PathBuf::from(format!("{ordinal}.dem")),
            size: 0,
            modified: 0,
            disk: DiskGroup {
                key: key.into(),
                limit,
            },
        };
        let jobs = vec![
            make(0, "hdd", 1),
            make(1, "hdd", 1),
            make(2, "ssd", 5),
            make(3, "ssd", 5),
        ];
        let mut active = HashMap::new();
        active.insert("hdd".into(), 1);
        active.insert("ssd".into(), 1);
        assert_eq!(
            next_scheduled_job(&jobs, &[true, false, true, false], &active, true),
            Some(3)
        );
        active.insert("ssd".into(), 5);
        assert_eq!(
            next_scheduled_job(&jobs, &[true, false, true, false], &active, true),
            None
        );
        assert_eq!(
            next_scheduled_job(&jobs, &[true, false, true, false], &active, false),
            Some(1)
        );
        active.insert("hdd".into(), 0);
        assert_eq!(
            next_scheduled_job(&jobs, &[true, false, true, false], &active, true),
            Some(1)
        );
        assert_eq!(
            parser_worker_count(None, &jobs),
            bounded_worker_count(
                6,
                std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(1),
                4
            )
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonical_windows_paths_keep_their_drive_for_disk_detection() {
        assert_eq!(
            volume_drive_letter(Path::new(r"F:\Dev\newdemos\a.dem")),
            Some(b'F')
        );
        assert_eq!(
            volume_drive_letter(Path::new(r"\\?\F:\Dev\newdemos\a.dem")),
            Some(b'F')
        );
        assert_eq!(
            volume_drive_letter(Path::new(r"D:\prodemos\a.dem")),
            Some(b'D')
        );
        assert_eq!(
            volume_drive_letter(Path::new(r"\\?\D:\prodemos\a.dem")),
            Some(b'D')
        );
        assert_eq!(
            volume_drive_letter(Path::new(r"\\server\share\a.dem")),
            None
        );
        assert_eq!(
            volume_drive_letter(Path::new(r"\\?\UNC\server\share\a.dem")),
            None
        );
        let directory = std::env::current_dir().unwrap();
        let canonical = std::fs::canonicalize(&directory).unwrap();
        assert_eq!(
            volume_drive_letter(&directory),
            volume_drive_letter(&canonical)
        );
        assert_eq!(disk_group(&directory), disk_group(&canonical));
    }

    #[test]
    fn auto_capacity_tracks_physical_disk() {
        let make = |ordinal: usize, key: &str, limit: usize| ParseJob {
            ordinal,
            file: PathBuf::from(format!("{ordinal}.dem")),
            size: 0,
            modified: 0,
            disk: DiskGroup {
                key: key.into(),
                limit,
            },
        };
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        let ssd: Vec<_> = (0..8)
            .map(|index| make(index, "ssd", AUTO_SSD_WORKERS))
            .collect();
        assert_eq!(
            parser_worker_count(None, &ssd),
            bounded_worker_count(5, available, 8)
        );
        let hdd: Vec<_> = (0..8).map(|index| make(index, "hdd", 1)).collect();
        assert_eq!(parser_worker_count(None, &hdd), 1);
        let mixed = [
            hdd[0].clone(),
            ssd[0].clone(),
            ssd[1].clone(),
            ssd[2].clone(),
            ssd[3].clone(),
            ssd[4].clone(),
        ];
        assert_eq!(
            parser_worker_count(None, &mixed),
            bounded_worker_count(6, available, 6)
        );
    }

    #[test]
    fn parser_control_sets_and_resets_cancellation() {
        let control = ParserControl::default();
        assert!(!control.is_cancelled());
        control.cancel();
        assert!(control.is_cancelled());
        control.reset();
        assert!(!control.is_cancelled());
    }

    #[test]
    fn parser_status_tracks_and_freezes_elapsed_time() {
        let mut status = ParserStatus::default();
        status.start("parsing");
        status.started_at = Instant::now().checked_sub(Duration::from_millis(25));
        status.update_elapsed();
        assert!(status.elapsed_ms >= 20);

        status.finish(Ok(None));
        let completed_elapsed = status.elapsed_ms;
        assert!(!status.running);
        assert_eq!(status.stage, "complete");
        assert!(status.started_at.is_none());

        std::thread::sleep(Duration::from_millis(2));
        status.update_elapsed();
        assert_eq!(status.elapsed_ms, completed_elapsed);
    }

    #[test]
    fn remove_nade_parser_removes_only_the_selected_executable() {
        let dir = std::env::temp_dir().join(format!(
            "nade-plugin-remove-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let plugin = dir.join("nade-parser.exe");
        let sibling = dir.join("keep.txt");
        std::fs::write(&plugin, b"plugin").unwrap();
        std::fs::write(&sibling, b"keep").unwrap();

        remove_nade_parser(&plugin).unwrap();

        assert!(!plugin.exists());
        assert!(sibling.exists());
        assert!(remove_nade_parser(&plugin).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

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
