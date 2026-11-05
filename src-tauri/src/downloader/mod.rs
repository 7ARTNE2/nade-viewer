use chrono::{Days, Local, NaiveDate, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

const BROWSER: &str = "hltv-browser";
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
pub(crate) struct Downloader {
    busy: AtomicBool,
    stop: AtomicBool,
    snapshot: Mutex<Option<Snapshot>>,
    browser_sender: Arc<Mutex<Option<mpsc::Sender<BrowserMessage>>>>,
    download_target: Arc<Mutex<Option<PathBuf>>>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Event {
    id: u64,
    url: String,
    name: String,
    start_date: Option<String>,
    end_date: Option<String>,
    prize: Option<u64>,
    player_share: Option<u64>,
    club_share: Option<u64>,
    teams: String,
    kind: String,
    location: String,
    status: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Job {
    id: String,
    url: String,
    name: String,
    status: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    archive: Option<String>,
    #[serde(default)]
    tournament: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    demo: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    events: Vec<Event>,
    jobs: Vec<Job>,
    updated_at: Option<i64>,
    destination: String,
    phase: String,
    current: String,
    bytes: u64,
    error: Option<String>,
    #[serde(default)]
    catalog_complete: bool,
    #[serde(default)]
    query: CatalogQuery,
    #[serde(default)]
    active_sources: Vec<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct CatalogQuery {
    start: Option<String>,
    end: Option<String>,
    min_prize: Option<u64>,
    max_prize: Option<u64>,
}

fn root(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("demo-downloader");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn db(app: &AppHandle) -> Result<Connection> {
    let conn = Connection::open(root(app)?.join("catalog.sqlite")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}
fn load(app: &AppHandle) -> Result<Snapshot> {
    let state = app.state::<Downloader>();
    let mut guard = state.snapshot.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let conn = db(app)?;
        let body = conn.query_row("SELECT body FROM state WHERE id=1", [], |r| {
            r.get::<_, String>(0)
        });
        let mut snapshot: Snapshot = match body {
            Ok(body) => serde_json::from_str(&body).map_err(|e| e.to_string())?,
            Err(rusqlite::Error::QueryReturnedNoRows) => Snapshot::default(),
            Err(e) => return Err(e.to_string()),
        };
        snapshot.phase = "idle".into();
        snapshot.current.clear();
        for job in &mut snapshot.jobs {
            if ["downloading", "extracting", "checking"].contains(&job.status.as_str()) {
                job.status = "interrupted".into();
            }
        }
        *guard = Some(snapshot);
    }
    Ok(guard.as_ref().unwrap().clone())
}
fn update(app: &AppHandle, change: impl FnOnce(&mut Snapshot)) -> Result<()> {
    load(app)?;
    let state = app.state::<Downloader>();
    let mut guard = state.snapshot.lock().map_err(|e| e.to_string())?;
    let snapshot = guard.as_mut().unwrap();
    change(snapshot);
    let body = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    db(app)?
        .execute(
            "INSERT INTO state VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            params![body],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn cancelled(app: &AppHandle) -> Result<()> {
    if app.state::<Downloader>().stop.load(Ordering::Acquire) {
        Err("Stopped".into())
    } else {
        Ok(())
    }
}
fn pause(app: &AppHandle, seconds: u64) -> Result<()> {
    for _ in 0..seconds * 5 {
        cancelled(app)?;
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}
fn phase(app: &AppHandle, phase: &str, current: &str) -> Result<()> {
    update(app, |s| {
        s.phase = phase.into();
        s.current = current.into();
        s.bytes = 0;
    })
}
fn begin(app: &AppHandle) -> Result<()> {
    if app
        .state::<Downloader>()
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Downloader is busy".into());
    }
    app.state::<Downloader>()
        .stop
        .store(false, Ordering::Release);
    if let Err(error) = phase(app, "starting", "") {
        app.state::<Downloader>()
            .busy
            .store(false, Ordering::Release);
        return Err(error);
    }
    Ok(())
}
fn finish(app: &AppHandle, result: Result<()>) {
    let stopped = app.state::<Downloader>().stop.load(Ordering::Acquire);
    let _ = update(app, |s| {
        s.phase = if stopped {
            "stopped"
        } else if result.is_err() {
            "failed"
        } else {
            "idle"
        }
        .into();
        s.error = if stopped { None } else { result.err() };
        for job in &mut s.jobs {
            if ["checking", "downloading", "extracting"].contains(&job.status.as_str()) {
                job.status = "interrupted".into();
            }
        }
    });
    if let Some(w) = app.get_webview_window(BROWSER) {
        let _ = w.hide();
    }
    app.state::<Downloader>()
        .busy
        .store(false, Ordering::Release);
}

enum BrowserMessage {
    Page(Value),
    Download(PathBuf, bool),
}
struct Browser {
    app: AppHandle,
    receiver: mpsc::Receiver<BrowserMessage>,
    request: u64,
    download: Arc<Mutex<Option<PathBuf>>>,
}
fn hltv(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("www.hltv.org")
}
fn download_host(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h == "hltv.org" || h.ends_with(".hltv.org"))
}
impl Browser {
    fn new(app: &AppHandle) -> Result<Self> {
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let handle = app.clone();
        let download = app.state::<Downloader>().download_target.clone();
        *download.lock().map_err(|e| e.to_string())? = None;
        let hub = app.state::<Downloader>().browser_sender.clone();
        *hub.lock().map_err(|e| e.to_string())? = Some(sender);
        if app.get_webview_window(BROWSER).is_some() {
            return Ok(Self {
                app: app.clone(),
                receiver,
                request: 0,
                download,
            });
        }
        let target = download.clone();
        let completion_target = download.clone();

        let profile = root(app)?.join("webview-profile");

        app.run_on_main_thread(move || {
            let nav = hub.clone();
            let done = hub;
            let result = WebviewWindowBuilder::new(
                &handle,
                BROWSER,
                WebviewUrl::External("https://www.hltv.org/events".parse().unwrap()),
            )
            .title("HLTV — NadeViewer")
            .inner_size(1050., 760.)
            .visible(false)
            .data_directory(profile)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_navigation(move |url| {
                if url.host_str() == Some("nadeviewer.invalid") && url.path() == "/report" {
                    if let Some((_, body)) = url.query_pairs().find(|(k, _)| k == "payload") {
                        if body.len() < 4_000_000 {
                            if let Ok(value) = serde_json::from_str(&body) {
                                if let Ok(hub) = nav.lock() {
                                    if let Some(sender) = hub.as_ref() {
                                        let _ = sender.send(BrowserMessage::Page(value));
                                    }
                                }
                            }
                        }
                    }
                    return false;
                }
                hltv(url) || download_host(url)
            })
            .on_download(move |_, event| match event {
                DownloadEvent::Requested { url, destination } => {
                    if !download_host(&url) {
                        return false;
                    }
                    if let Some(path) = target.lock().ok().and_then(|p| p.clone()) {
                        *destination = path;
                        true
                    } else {
                        false
                    }
                }
                DownloadEvent::Finished { path, success, .. } => {
                    if let Some(path) =
                        path.or_else(|| completion_target.lock().ok().and_then(|p| p.clone()))
                    {
                        if let Ok(hub) = done.lock() {
                            if let Some(sender) = hub.as_ref() {
                                let _ = sender.send(BrowserMessage::Download(path, success));
                            }
                        }
                    }
                    true
                }
                _ => false,
            })
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string());
            let _ = ready_tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        ready_rx
            .recv_timeout(Duration::from_secs(45))
            .map_err(|e| e.to_string())??;
        Ok(Self {
            app: app.clone(),
            receiver,
            request: 0,
            download,
        })
    }
    fn page(&mut self, url: &str) -> Result<Value> {
        let parsed: tauri::Url = url.parse().map_err(|_| "Invalid URL")?;
        if !hltv(&parsed) {
            return Err("Only HLTV pages are supported".into());
        }
        self.request += 1;
        let request = self.request;
        let window = self
            .app
            .get_webview_window(BROWSER)
            .ok_or("HLTV window was closed")?;
        window.navigate(parsed).map_err(|e| e.to_string())?;
        let script = include_str!("page.js")
            .replace("__EXPECTED__", &json!(url).to_string())
            .replace("__REQUEST__", &request.to_string());
        let start = Instant::now();
        let mut last = Instant::now();
        let mut shown = false;
        while start.elapsed() < Duration::from_secs(180) {
            cancelled(&self.app)?;
            if last.elapsed() > Duration::from_secs(2) {
                window.eval(&script).map_err(|e| e.to_string())?;
                last = Instant::now();
            }
            if let Ok(BrowserMessage::Page(page)) =
                self.receiver.recv_timeout(Duration::from_millis(200))
            {
                if page["request"].as_u64() != Some(request) || page["url"].as_str() != Some(url) {
                    continue;
                }
                if page["challenge"].as_bool() == Some(true) {
                    phase(&self.app, "browser_action", url)?;
                    window.show().map_err(|e| e.to_string())?;
                    shown = true;
                    continue;
                }
                if page["valid"].as_bool() == Some(true) {
                    if shown {
                        let _ = window.hide();
                    }
                    return Ok(page);
                }
            }
        }
        Err("HLTV page did not load. Open the HLTV window and try again.".into())
    }
    fn fetch_demo(&self, path: &Path, demo: &str) -> Result<()> {
        *self.download.lock().map_err(|e| e.to_string())? = Some(path.to_path_buf());
        let url = tauri::Url::parse("https://www.hltv.org")
            .unwrap()
            .join(demo)
            .map_err(|e| e.to_string())?;
        if !hltv(&url) || !url.path().starts_with("/download/demo/") {
            return Err("Invalid demo URL".into());
        }
        self.app
            .get_webview_window(BROWSER)
            .ok_or("HLTV window closed")?
            .navigate(url)
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        let mut last = Instant::now();
        while start.elapsed() < Duration::from_secs(1800) {
            cancelled(&self.app)?;
            if last.elapsed() > Duration::from_secs(1) {
                let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                update(&self.app, |s| s.bytes = bytes)?;
                last = Instant::now();
            }
            if let Ok(BrowserMessage::Download(actual, ok)) =
                self.receiver.recv_timeout(Duration::from_millis(200))
            {
                if actual == path
                    || fs::canonicalize(&actual)
                        .ok()
                        .zip(fs::canonicalize(path).ok())
                        .is_some_and(|(a, b)| a == b)
                {
                    return if ok {
                        Ok(())
                    } else {
                        Err("HLTV download failed; retry the queue".into())
                    };
                }
            }
        }
        Err("Demo download timed out".into())
    }
}

fn page_next(page: &Value) -> Result<Option<String>> {
    page["next"]
        .as_str()
        .map(|href| {
            let url = tauri::Url::parse("https://www.hltv.org")
                .unwrap()
                .join(href)
                .map_err(|e| e.to_string())?;
            if !hltv(&url) {
                return Err("Invalid pagination URL".into());
            }
            Ok(url.to_string())
        })
        .transpose()
}
fn validate_date(value: &Option<String>) -> Result<()> {
    if let Some(value) = value {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "Invalid date")?;
    }
    Ok(())
}
fn catalog(app: &AppHandle, query: CatalogQuery) -> Result<()> {
    phase(app, "catalog", "HLTV")?;
    let mut browser = Browser::new(app)?;
    let end = query
        .end
        .clone()
        .unwrap_or_else(|| Local::now().date_naive().to_string());
    let start = query
        .start
        .clone()
        .unwrap_or_else(|| (Local::now().date_naive() - Days::new(92)).to_string());
    let mut url = tauri::Url::parse("https://www.hltv.org/events/archive").unwrap();
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("gameType", "CS2")
            .append_pair("endDate", &end);
        if query.min_prize.is_some() || query.max_prize.is_some() {
            q.append_pair("prizeMin", &query.min_prize.unwrap_or(0).to_string())
                .append_pair(
                    "prizeMax",
                    &query.max_prize.unwrap_or(1_000_000_000).to_string(),
                );
        }
    }
    let mut next = Some(url.to_string());
    let mut seen = HashSet::new();
    let mut found = BTreeMap::new();
    let mut complete = false;
    while let Some(url) = next {
        if !seen.insert(url.clone()) || seen.len() > 100 {
            break;
        }
        phase(app, "catalog", &format!("HLTV · {}", seen.len()))?;
        let page = browser.page(&url)?;
        let events: Vec<Event> =
            serde_json::from_value(page["events"].clone()).map_err(|e| e.to_string())?;
        let past = events
            .iter()
            .filter_map(|e| e.end_date.as_deref())
            .any(|d| d < start.as_str());
        for event in events {
            if event
                .end_date
                .as_ref()
                .is_some_and(|d| d >= &start && d <= &end)
            {
                found.insert(event.id, event);
            }
        }
        next = page_next(&page)?;
        if past || next.is_none() {
            complete = true;
            break;
        }
        pause(app, 2)?;
    }
    pause(app, 2)?;
    let ongoing = browser.page("https://www.hltv.org/events")?;
    let events: Vec<Event> =
        serde_json::from_value(ongoing["events"].clone()).map_err(|e| e.to_string())?;
    for event in events {
        found.insert(event.id, event);
    }
    update(app, |s| {
        s.events = found.into_values().collect();
        s.updated_at = Some(Utc::now().timestamp());
        s.catalog_complete = complete;
        s.query = query;
        s.error = None;
    })
}

fn normalize_url(input: &str) -> Result<(String, String)> {
    let mut url: tauri::Url = input.trim().parse().map_err(|_| "Invalid HLTV URL")?;
    if !hltv(&url) {
        return Err("Use https://www.hltv.org/events/… or /matches/…".into());
    }
    let parts: Vec<_> = url.path_segments().ok_or("Invalid URL")?.collect();
    if parts.len() < 2
        || !["events", "matches"].contains(&parts[0])
        || parts[1].parse::<u64>().is_err()
    {
        return Err("Use a tournament or match URL".into());
    }
    let id = format!("{}:{}", parts[0], parts[1]);
    url.set_query(None);
    url.set_fragment(None);
    Ok((id, url.into()))
}
fn add_job(s: &mut Snapshot, url: String) -> Result<()> {
    let (id, url) = normalize_url(&url)?;
    if !s.jobs.iter().any(|j| j.id == id) {
        s.jobs.push(Job {
            id,
            name: url.rsplit('/').next().unwrap_or(&url).replace('-', " "),
            url,
            status: "queued".into(),
            ..Job::default()
        });
    }
    Ok(())
}
fn seven(app: &AppHandle) -> Result<PathBuf> {
    let roots = crate::resource_dir_candidates(app).map_err(|e| e.to_string())?;
    find_seven(roots).ok_or_else(|| {
        "Bundled 7-Zip (7z.exe and 7z.dll) is missing. Rebuild or reinstall NadeViewer.".into()
    })
}
fn find_seven(roots: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    roots.into_iter().find_map(|root| {
        let folder = root.join("runtime/7zip");
        let executable = folder.join("7z.exe");
        (executable.is_file() && folder.join("7z.dll").is_file()).then_some(executable)
    })
}
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', ' '])
        .into()
}
fn collect_demos(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Archive contains a symbolic link".into());
        }
        if kind.is_dir() {
            collect_demos(&entry.path(), files)?;
        } else if entry
            .path()
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("dem"))
        {
            files.push(entry.path());
        }
    }
    Ok(())
}
fn extract(
    app: &AppHandle,
    archive: &Path,
    folder: &Path,
    destination: &Path,
    tournament: &str,
    date: &str,
) -> Result<Vec<String>> {
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let log = fs::File::create(folder.join("extract.log")).map_err(|e| e.to_string())?;
    // Flattening archive members prevents archive paths escaping the temporary
    // directory. Demo filenames are retained, including multipart suffixes.
    let mut command = Command::new(seven(app)?);
    command
        .args(["e", "-y", "-aoa", "-bsp0", "-bd"])
        .arg(archive)
        .arg(format!("-o{}", folder.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    let mut child = crate::plugin::hide_console(&mut command)
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if cancelled(app).is_err() || started.elapsed() > Duration::from_secs(1200) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Extraction interrupted; archive retained".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(format!("7-Zip failed ({status}); archive retained"));
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let mut demos = Vec::new();
    collect_demos(folder, &mut demos)?;
    if demos.is_empty() {
        return Err("Archive contains no .dem files".into());
    }
    let mut targets = Vec::new();
    for demo in &demos {
        let mut header = [0; 8];
        fs::File::open(demo)
            .and_then(|mut f| f.read_exact(&mut header))
            .map_err(|e| e.to_string())?;
        if &header != b"PBDEMS2\0" {
            return Err("Invalid CS2 demo header; archive retained".into());
        }
        let stem = demo.file_stem().unwrap_or_default().to_string_lossy();
        let name = safe_name(&format!("{tournament}_{stem}_{date}"));
        let mut target = destination.join(format!("{name}.dem"));
        let mut duplicate = 0;
        while target.exists() {
            duplicate += 1;
            target = destination.join(format!("{name}_dup{duplicate}.dem"));
        }
        targets.push((demo.clone(), target));
    }
    let mut saved: Vec<PathBuf> = Vec::new();
    for (source, target) in targets {
        if let Err(error) = fs::rename(&source, &target) {
            for path in &saved {
                let _ = fs::remove_file(path);
            }
            return Err(error.to_string());
        }
        saved.push(target);
    }
    Ok(saved.iter().map(|p| p.to_string_lossy().into()).collect())
}
fn job_update(app: &AppHandle, id: &str, change: impl FnOnce(&mut Job)) -> Result<()> {
    update(app, |s| {
        if let Some(job) = s.jobs.iter_mut().find(|j| j.id == id) {
            change(job);
        }
    })
}
fn process_match(
    app: &AppHandle,
    browser: &mut Browser,
    job: &Job,
    destination: &Path,
) -> Result<()> {
    job_update(app, &job.id, |j| {
        j.status = "checking".into();
        j.error = None;
    })?;
    phase(app, "checking", &job.name)?;
    let folder = destination
        .join(".nadeviewer-downloads")
        .join(job.id.replace(':', "-"));
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let archive = folder.join("demo.rar");
    let retained = job
        .archive
        .as_deref()
        .is_some_and(|p| Path::new(p) == archive && archive.is_file())
        && !job.tournament.is_empty()
        && !job.date.is_empty();
    let (tournament, date) = if retained {
        (job.tournament.clone(), job.date.clone())
    } else {
        let page = browser.page(&job.url)?;
        let Some(demo) = page["demo"].as_str() else {
            return job_update(app, &job.id, |j| j.status = "no_demo".into());
        };
        let tournament = page["tournament"]
            .as_str()
            .ok_or("Missing tournament")?
            .to_string();
        let date = page["date"]
            .as_str()
            .ok_or("Missing match date")?
            .to_string();
        job_update(app, &job.id, |j| {
            j.tournament = tournament.clone();
            j.date = date.clone();
            j.demo = demo.into();
            j.archive = None;
            j.status = "downloading".into();
        })?;
        phase(app, "downloading", &job.name)?;
        pause(app, 3)?;
        // An unfinished browser download is never reused as a valid archive.
        if archive.exists() {
            fs::remove_file(&archive).map_err(|e| e.to_string())?;
        }
        browser.fetch_demo(&archive, demo)?;
        job_update(app, &job.id, |j| {
            j.archive = Some(archive.to_string_lossy().into())
        })?;
        (tournament, date)
    };
    job_update(app, &job.id, |j| j.status = "extracting".into())?;
    phase(app, "extracting", &job.name)?;
    let extracted = folder.join("extracted");
    let files = extract(app, &archive, &extracted, destination, &tournament, &date)?;
    // Persist the complete file list before deleting the only source archive.
    job_update(app, &job.id, |j| {
        j.files = files;
        j.status = "complete".into();
        j.error = None;
    })?;
    fs::remove_file(&archive)
        .map_err(|e| format!("Demos saved, but archive cleanup failed: {e}"))?;
    fs::remove_dir_all(&extracted)
        .map_err(|e| format!("Demos saved, but temporary cleanup failed: {e}"))?;
    let _ = fs::remove_dir(&folder);
    if let Some(parent) = folder.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}
fn run_queue(app: &AppHandle) -> Result<()> {
    let snapshot = load(app)?;
    let destination = PathBuf::from(&snapshot.destination);
    if !destination.is_absolute() {
        return Err("Choose an absolute destination folder".into());
    }
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let destination = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    seven(app)?;
    phase(app, "checking", "HLTV")?;
    let mut browser = Browser::new(app)?;
    let mut work = HashSet::new();
    for source in &snapshot.active_sources {
        if source.starts_with("matches:") {
            work.insert(source.clone());
        }
    }
    let events: Vec<_> = snapshot
        .jobs
        .iter()
        .filter(|j| j.id.starts_with("events:") && snapshot.active_sources.contains(&j.id))
        .cloned()
        .collect();
    for event in events {
        phase(app, "discovering", &event.name)?;
        let event_id = event.id.split(':').nth(1).unwrap();
        let mut next = Some(format!("https://www.hltv.org/results?event={event_id}"));
        let mut seen = HashSet::new();
        let mut urls = Vec::new();
        while let Some(url) = next {
            if !seen.insert(url.clone()) || seen.len() > 100 {
                return Err("Unexpected result pagination".into());
            }
            let page = browser.page(&url)?;
            let matches: Vec<String> =
                serde_json::from_value(page["matches"].clone()).map_err(|e| e.to_string())?;
            urls.extend(matches);
            next = page_next(&page)?;
            if next.is_some() {
                pause(app, 2)?;
            }
        }
        urls.reverse();
        if urls.is_empty() {
            job_update(app, &event.id, |j| {
                j.status = "no_demo".into();
                j.error = Some("No completed matches found".into());
            })?;
            continue;
        }
        for url in urls {
            let (id, _) = normalize_url(&url)?;
            work.insert(id);
            update(app, |s| {
                let _ = add_job(s, url);
            })?;
        }
        job_update(app, &event.id, |j| j.status = "expanded".into())?;
    }
    let jobs = load(app)?.jobs;
    let mut failures = 0;
    for job in jobs.iter().filter(|j| work.contains(&j.id)) {
        cancelled(app)?;
        if job.status == "complete"
            && !job.files.is_empty()
            && job.files.iter().all(|p| {
                Path::new(p).is_file() && Path::new(p).parent() == Some(destination.as_path())
            })
        {
            continue;
        }
        if let Err(error) = process_match(app, &mut browser, job, &destination) {
            job_update(app, &job.id, |j| {
                if j.status != "complete" {
                    j.status = if cancelled(app).is_err() {
                        "interrupted"
                    } else {
                        "failed"
                    }
                    .into();
                }
                j.error = Some(error.clone());
            })?;
            cancelled(app)?;
            failures += 1;
            // A challenge/failed page stops the queue instead of hammering HLTV.
            if error.contains("HLTV page") {
                return Err(error);
            }
        }
        pause(app, 3)?;
    }
    if failures > 0 {
        Err(format!("{failures} matches failed. Retry to continue."))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn get_demo_downloader(app: AppHandle) -> Result<Snapshot> {
    tauri::async_runtime::spawn_blocking(move || load(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn refresh_demo_catalog(app: AppHandle, query: CatalogQuery) -> Result<()> {
    validate_date(&query.start)?;
    validate_date(&query.end)?;
    if query
        .start
        .as_ref()
        .zip(query.end.as_ref())
        .is_some_and(|(a, b)| a > b)
        || query
            .min_prize
            .zip(query.max_prize)
            .is_some_and(|(a, b)| a > b)
    {
        return Err("Invalid filter range".into());
    }
    begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = catalog(&app, query);
        finish(&app, result);
    });
    Ok(())
}
#[tauri::command]
pub(crate) async fn start_demo_downloads(
    app: AppHandle,
    urls: Vec<String>,
    destination: String,
) -> Result<()> {
    if !Path::new(&destination).is_absolute() {
        return Err("Choose a destination folder".into());
    }
    for url in &urls {
        normalize_url(url)?;
    }
    begin(&app)?;
    if let Err(error) = update(&app, |s| {
        s.destination = destination;
        s.error = None;
        if !urls.is_empty() {
            s.active_sources.clear();
        }
        for url in urls {
            if let Ok((id, _)) = normalize_url(&url) {
                s.active_sources.push(id);
            }
            let _ = add_job(s, url);
        }
    }) {
        app.state::<Downloader>()
            .busy
            .store(false, Ordering::Release);
        return Err(error);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_queue(&app);
        finish(&app, result);
    });
    Ok(())
}
#[tauri::command]
pub(crate) fn stop_demo_downloads(app: AppHandle) {
    app.state::<Downloader>()
        .stop
        .store(true, Ordering::Release);
    if let Some(w) = app.get_webview_window(BROWSER) {
        let _ = w.close();
    }
}
#[tauri::command]
pub(crate) fn show_hltv_browser(app: AppHandle) -> Result<()> {
    let w = app
        .get_webview_window(BROWSER)
        .ok_or("HLTV session is not running")?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn select_demo_destination() -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .pick_folder()
            .map(|p| p.to_string_lossy().into()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn clear_demo_queue(app: AppHandle) -> Result<()> {
    begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = update(&app, |s| {
            s.jobs.retain(|j| j.status == "complete");
            s.active_sources.clear();
            s.phase = "idle".into();
        });
        app.state::<Downloader>()
            .busy
            .store(false, Ordering::Release);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seven_zip_search_skips_stale_and_incomplete_resource_directories() {
        let root = std::env::temp_dir().join(format!(
            "nadeviewer-seven-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let stale = root.join("stale");
        let complete = root.join("complete");
        let stale_folder = stale.join("runtime/7zip");
        let complete_folder = complete.join("runtime/7zip");
        fs::create_dir_all(&stale_folder).unwrap();
        fs::create_dir_all(&complete_folder).unwrap();
        fs::write(stale_folder.join("7z.exe"), b"fixture").unwrap();
        fs::write(complete_folder.join("7z.exe"), b"fixture").unwrap();
        fs::write(complete_folder.join("7z.dll"), b"fixture").unwrap();
        assert_eq!(find_seven([stale.clone()]), None);
        assert_eq!(
            find_seven([root.join("missing"), stale, complete]),
            Some(complete_folder.join("7z.exe"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restrict_urls_and_preserve_match_identity() {
        assert!(normalize_url("https://www.hltv.org.evil.test/events/123/x").is_err());
        assert!(normalize_url("http://www.hltv.org/events/123/x").is_err());
        assert!(normalize_url("https://www.hltv.org/results?event=123").is_err());
        assert_eq!(
            normalize_url("https://www.hltv.org/matches/123/a?x=1#y").unwrap(),
            (
                "matches:123".into(),
                "https://www.hltv.org/matches/123/a".into()
            )
        );
    }
    #[test]
    fn queue_deduplicates_ids_and_names_keep_parts() {
        let mut state = Snapshot::default();
        add_job(&mut state, "https://www.hltv.org/matches/123/a".into()).unwrap();
        add_job(
            &mut state,
            "https://www.hltv.org/matches/123/new-slug".into(),
        )
        .unwrap();
        assert_eq!(state.jobs.len(), 1);
        assert_eq!(
            safe_name("Thunderpick 2026_team-m1-ancient-p2_2026-10-15"),
            "Thunderpick 2026_team-m1-ancient-p2_2026-10-15"
        );
        assert_eq!(safe_name("A: B / C"), "A_ B _ C");
    }
}
