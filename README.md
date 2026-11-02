# Nade Viewer

Nade Viewer is a Windows desktop application for browsing Counter-Strike grenade
lineups from local JSON and MessagePack files. It imports lineups into a local SQLite database
and presents them on bundled radar images. An optional online library update path
can download a MessagePack snapshot from a configured HTTPS URL and verify its digest.
It also replays local CS2 demos on a 2D radar and saves round-linked text and
drawing notes for reviewing matches.

Current application version: **0.7.1**.

## What's new in 0.7.1

- Nuke replay shows the main radar on the left and the lower radar on the right,
  with independent zoom and pan. Both stay visible in compact windows.
- Both Nuke radars share one Notes button, note list, drawing tools, and color
  palette. Drawings remain attached to their own floor, and saved note links
  restore the selected drawing in the common editor.
- The mouse wheel zooms the radar while drawing, keeping completed strokes
  anchored to the map. Scrolling the notes panel does not zoom the radar.
- Replay arrows work after focusing either radar: Up/Down change playback
  speed, and Left/Right pause and seek five seconds within the current round.
- The shared killfeed uses the application's team colors and font, shows up to
  five recent kills, and fades after six seconds of demo time. Pausing, changing
  speed, and seeking keep it synchronized with the replay.

## What's new in 0.7.0

- Replay local CS2 demos with round previews, a phase and event timeline,
  interpolated player movement, equipment, killfeed, and grenade effects.
- Annotate moments with text and radar drawings, saved automatically in SQLite.
  Browse notes from every match alongside replay history and jump to their exact
  round, time, and radar level.
- Filter notes by match, map, round, and text/drawing content, search their text
  and match details, and sort by last edit or match, round, and time.
- See damage and flash assists consistently in the killfeed and kill previews.
  Flying grenade silhouettes use the timeline's colors; molotovs have animated
  flames. Replay controls use the application's standard tooltips.
- The section is named **Replay** in English and **Повторы** in Russian.

## Features

- Imports canonical `grenade_index` JSON/MessagePack snapshots and Nadegrid
  Screenshot Capture ZIP archives with their lineup images.
- Keeps multiple imports, lets the user switch between them, rename them, and
  delete them.
- Groups grenade starts and landings on map radars.
- Filters by grenade type, side, usage count, radar level, insta status, thrower,
  thrower team, player, tournament, demo name, and coordinates.
- Shows usage snapshots, trajectories, lineup metadata, similar grenades, spawn points, and
  recently viewed grenades when the source data supports them.
- Copies grenade and spawn coordinates with animated success and error feedback.
- Uses a responsive map workspace, persistent view settings, onboarding, and
  localized animated notifications.
- Stores imported lineups, Favorites, parsed replays, and replay notes locally in SQLite.
- Saves independent grenade snapshots to Favorites and organizes them into named
  collections. Saved data, trajectories, statistics, and screenshots remain
  available after switching or deleting libraries, including the last library.
- Provides English and Russian interfaces.

### Replay / Повторы

The **Replay** section (**Повторы** in Russian) opens local CS2 demos through the separately installed
Nade Parser 0.3.0 or newer. The player includes rounds, a seekable timeline,
0.25x to 4x playback, player positions and equipment, kills, bomb state, smoke
and fire effects, and selectable grenade trajectories with copyable lineup
coordinates. Nuke opens two equally sized radars side by side: main on the left,
lower on the right, each with independent zoom and pan. The layout stays side
by side at every window width. Vertigo retains its upper/lower radar switch.

Replay samples default to **16 frames per second**, every four ticks for a
64-tick demo, with interpolated rendering. Grenade detection runs on every demo
tick through the same collector as the existing grenade export.

Parsed matches are stored locally in a separate `replays.sqlite` database, with
compressed round data loaded as needed. Saved matches remain playable without
the original demo or the parser plugin. The history supports deletion and resumes
the last viewed round and position. Removing a match does not delete its demo.
Replay does not automatically import grenades into a library or Favorites.

#### Playback and previews

Use the horizontal round strip to select rounds and preview their events on
hover. Timeline previews show kills, damage and flash assists, grenade throws,
and bomb events. Grenade icons on the radar follow their trajectories and use
the same type colors as the timeline. Selecting a grenade exposes its throw
details and copyable commands.

| Control          | Action                                                  |
| ---------------- | ------------------------------------------------------- |
| Space            | Pause or resume playback                                |
| Left / Right     | Pause and seek backward / forward by five demo seconds  |
| Up / Down        | Raise / lower speed: 0.25x, 0.5x, 1x, 2x, 4x            |
| Mouse wheel      | Zoom the radar under the cursor, including drawing mode |
| Left-button drag | Pan a zoomed radar when drawing is closed               |
| + / -            | Zoom in / out when the radar is focused                 |
| Home / 0         | Reset the focused radar's view                          |

Holding Left or Right repeats five-second seeks. Keyboard seeking stops at the
current round's boundaries and respects the freeze-time visibility setting;
it does not switch rounds. Speed shortcuts keep the current play/pause state.
Typing, sliders, selection controls, and open menus or dialogs retain their
own keyboard handling. The mouse wheel zooms from 1x to 6x around the cursor;
scrolling over the notes panel scrolls that panel instead.

Freeze time is hidden by default and can be enabled in the replay options.
Automatic advance to the next round is optional; playback pauses when the app
loses focus.

The killfeed appears once at the top right of the radar area, including on
Nuke. It keeps the latest five kills for six seconds of demo time and fades
during the final 0.3 seconds. A paused replay keeps the current entries visible;
at 2x speed, six demo seconds take three real seconds. Seeking reconstructs the
feed at the selected position. Names use the application's orange T and blue
CT colors and existing font; damage and flash assists and special-kill icons
remain visible.

#### Notes and drawings

Open **Notes** in the player to pause playback and annotate the current moment.
Write text, draw freehand, or use arrows and circles. The palette provides
preset and custom colors, and Undo removes the last stroke. Notes belong to a
specific match, round, tick, and radar level; a round badge marks rounds with
notes. Opening a note restores its time, floor, and drawings, including notes
made during freeze time.

Nuke uses one shared Notes button, editor, note list, drawing tool, and color
selection for both radars. Opening Notes enables drawing on either floor.
Selecting a note from the common list displays its strokes on that floor;
drawing on the other floor creates a separate note for that floor. The shared
Undo action edits the selected note. Existing notes keep their floor assignment
and require no conversion.

Zooming preserves completed drawing coordinates. If the wheel is used while a
stroke is still in progress, only that unfinished stroke is discarded. Closing
Notes exits drawing mode on both Nuke radars.

The panel next to the match list initially shows **all notes from all saved
matches**. Search by text, demo filename, map, team, or round, and combine the
match, map, round, and content-type filters. Choose **With text**, **With
drawings**, or **Text and drawings**; sort by most recently edited or by match,
round, and time. The note-count button on a match filters the panel to that
match; click it again to clear that match filter, or reset all filters to show
every match.

Text and drawing coordinates are saved automatically in the `replay_notes`
table in `replays.sqlite`. Notes use the saved match ID rather than its parse
timestamp. Saving is transactional, and an unsuccessful write retains the
current edits with a Retry action. Notes remain available after restarting
the app. Deleting an individual note removes it from the database; deleting
the match removes all its notes. Notes are local and are not included in
Favorites `.nvshare` exports.

### Favorites and collections

Click a grenade's star in a lineup list or its detail page to save it. The
collection button assigns the saved grenade to one or more collections of its map; a grenade
can also remain in All favorites without belonging to a collection. Removing a
star removes that saved copy from all collections. Deleting a collection keeps
its grenades in All favorites.

Favorites opens with a persistent map strip showing the total number of saved
grenades per map, regardless of filters or collection selection. Choose a map,
then All favorites or one of that map's collections. Switching maps opens All
favorites for the new map. Maps with no saved grenades remain available, and
collections can be created before saving the first grenade. Counts do not double
count grenades belonging to multiple collections.

Existing single-map collections are assigned to their map automatically. Mixed
collections split into collections with the same name for each map, preserving
all memberships. Empty legacy collections require choosing a map in Favorites
before they can be used.

Favorites are immutable snapshots of the data at the time of saving. Library
updates do not replace their statistics or screenshots. The Favorites section
works even when no imported library remains.

Use the compact Export menu next to the collection selector in Favorites to
save a portable `.nvshare` file. Choose Collection to export any named
collection on the current map (including an empty collection), All favorites
on this map, or All maps. Exports include the complete selected
set regardless of filters or pagination, collection names and memberships,
statistics, trajectories, demo metadata, saved dates, and embedded screenshots.
An individual collection export includes only that collection. Map and all-map
exports also retain empty collections with an assigned map; assign a map to
legacy empty collections before sharing them.

The recipient opens the file on the regular Import page (file picker or drag and
drop). The app detects favorites packages separately from library files and
adds them directly to Favorites, keeping the active library. Existing saved
lineups retain their data and screenshots, while new collection memberships
are added. Collections with the same name on the same map are merged. Repeating
an import does not duplicate saved lineups or memberships. Files use the
`nade-viewer-favorites` MessagePack envelope, version 1, and require an app
version that supports favorites sharing.

Default names include the local date in `YYYY-MM-DD` format:
`mirage-2026-10-15.nvshare` for a map,
`mirage-Атака-A-2026-10-15.nvshare` for a collection, and
`all-2026-10-15.nvshare` for all maps.
Collection names retain Unicode, are limited to 32 characters, and have invalid
Windows filename characters replaced with hyphens. The complete filename stem
is limited to 64 characters including the date. Existing files use the native overwrite prompt;
if a manually entered extension needs correction, the save dialog reopens with
the final `.nvshare` filename before anything is written.
The content remains MessagePack. Older `.nvshare.msgpack`, `.msgpack`,
`.messagepack`, and `.mpk` favorites packages remain importable.

The map's Favorites only filter shows matching records from the **active
library**, optionally restricted to a collection. Matching requires the same
normalized map, type, side, throw keys, coordinate text, and exact world
positions; player names and usage counts may differ. Records without coordinate
text and without complete start/landing positions match only their original
source record. Saved copies from other or deleted libraries remain accessible
through the Favorites section.

The accepted library structures, field requirements, examples, and import
limitations are documented in [Data formats](docs/data-formats.md).

## Technology stack

Versions below are the resolved versions from `package-lock.json` and
`src-tauri/Cargo.lock` for Nade Viewer 0.7.1.

### Application architecture

- **Desktop runtime:** Tauri 2.10.3 with a Rust backend and the system WebView2
  runtime on Windows.
- **Frontend:** React 18.3.1 single-page application written in strict
  TypeScript and bundled by Vite.
- **Backend:** Rust 2021 commands exposed to the frontend through Tauri IPC.
- **Storage:** local SQLite through `rusqlite`; SQLite is statically bundled and
  does not require a separate installation.
- **Routing:** client-side routing with React Router; application data remains
  local, with an optional HTTPS snapshot download for library updates.
- **Distribution:** native Windows MSI and NSIS installers generated by Tauri.
- **Automation:** GitHub Actions on `windows-latest` with Node.js 22 and the
  stable `x86_64-pc-windows-msvc` Rust toolchain.

### Frontend and tooling

| Technology                   | Version | Purpose                                    |
| ---------------------------- | ------: | ------------------------------------------ |
| React                        |  18.3.1 | Component UI and application state         |
| React DOM                    |  18.3.1 | WebView rendering                          |
| React Router DOM             |  6.30.4 | Client-side navigation                     |
| TypeScript                   |   5.9.3 | Strict static typing, targeting ES2020     |
| Vite                         |   6.4.3 | Development server and production bundling |
| `@vitejs/plugin-react`       |   4.7.0 | React integration for Vite                 |
| `@tauri-apps/api`            |  2.10.1 | Frontend access to Tauri APIs              |
| `@tauri-apps/cli`            |  2.10.1 | Desktop development and packaging          |
| `@tauri-apps/plugin-updater` |  2.10.1 | Signed application updates                 |
| Lucide React                 | 0.468.0 | Interface icons                            |
| ESLint                       |  9.39.5 | JavaScript and TypeScript linting          |
| `typescript-eslint`          |  8.64.0 | TypeScript ESLint integration              |
| Prettier                     |   3.9.5 | Source formatting checks                   |
| Playwright                   |  1.64.1 | Browser regression checks                  |

The project also uses `@eslint/js` 9.39.5, `@types/react` 18.3.28, and
`@types/react-dom` 18.3.7 for lint configuration and React type declarations.

### Rust and native dependencies

| Crate                  | Version | Purpose                                   |
| ---------------------- | ------: | ----------------------------------------- |
| Tauri                  |  2.10.3 | Native application runtime and IPC        |
| `tauri-build`          |   2.5.6 | Tauri build-time integration              |
| `rusqlite`             |  0.32.1 | Bundled SQLite storage and queries        |
| Serde                  | 1.0.228 | Rust data serialization                   |
| `serde_json`           | 1.0.149 | JSON import and export                    |
| `rmp-serde`            |   1.3.1 | MessagePack import                        |
| `reqwest`              |  0.13.2 | HTTPS manifest and data downloads         |
| `sha2`                 |  0.10.9 | Download integrity verification           |
| Chrono                 |  0.4.44 | Date and time handling                    |
| Regex                  |  1.12.3 | Parsing and text normalization            |
| RFD                    |  0.15.4 | Native file selection dialogs             |
| Thiserror              |  2.0.18 | Structured backend errors                 |
| `tauri-plugin-updater` |  2.10.1 | Signed Windows application updates        |
| `zstd`                 |  0.13.3 | Compressed replay rounds and library data |
| `zip`                  |   2.4.2 | Screenshot archive imports                |
| Image                  | 0.25.10 | Screenshot processing                     |

### Quality and release pipeline

- TypeScript runs with `strict`, `isolatedModules`, and bundler module
  resolution enabled.
- Frontend quality gates include Prettier, ESLint, TypeScript type-checking, and
  a production Vite build.
- Backend quality gates include `cargo fmt`, `cargo check`, Rust unit tests, and
  Clippy with warnings treated as errors.
- CI runs for pushes and pull requests. A semantic version tag starts the
  Windows release workflow and publishes both installer formats.

## Windows prerequisites

Development and local builds require:

- Node.js with npm (the lockfile is committed).
- Rust with the stable MSVC toolchain.
- Microsoft C++ Build Tools, including the "Desktop development with C++"
  workload and a Windows SDK.
- Microsoft Edge WebView2 Runtime.

These are the native prerequisites for the Tauri 2 application used by this
repository. The SQLite dependency is bundled by `rusqlite`; a separate SQLite
installation is not required.

## Development

Install JavaScript dependencies from the repository root:

```powershell
npm ci
```

Run the complete desktop application with Vite hot reload:

```powershell
npm run tauri:dev
```

`npm run dev` starts only the Vite frontend. Most application operations call
Tauri commands, so use `npm run tauri:dev` for normal development.

## Build

Type-check and build the frontend:

```powershell
npm run build
```

Build the Windows application and the configured MSI and NSIS bundles:

```powershell
npm run tauri:build
```

Tauri build artifacts are written below `src-tauri/target/release/`; installers
are placed below `src-tauri/target/release/bundle/`.

## GitHub Releases

The repository contains a GitHub Actions workflow at
`.github/workflows/release.yml`. It builds the Windows MSI and NSIS installers
and attaches them to a GitHub Release. The workflow supports both version tags
and manual runs.

### Release from a version tag

Keep the version synchronized in these files before creating a release:

- `package.json`
- `package-lock.json` (root version and root package version)
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` (the `nade-viewer` package)
- The current version and release examples in this README

The application header and startup screen read their version from `package.json`.
The separately distributed Nade Parser has its own version and is not bumped
for Viewer releases.

Create and push a semantic-version tag from the repository root:

```powershell
git tag -a v0.7.1 -m "Nade Viewer 0.7.1"
git push --atomic origin main v0.7.1
```

Pushing the tag starts the `Release` workflow automatically. It builds the
installers and creates a GitHub Release with files from:

```text
src-tauri/target/release/bundle/msi/*.msi
src-tauri/target/release/bundle/nsis/*.exe
```

Each release also includes the signed NSIS updater's `.sig` file and
`latest.json` manifest. Published NSIS filenames replace spaces with dots.
The release workflow validates that the tag matches the npm, Tauri, and Rust
application versions; the CI workflow runs the quality checks separately.

### Online library updates

Installed builds check a separate data manifest at:

```text
https://github.com/7ARTNE2/nade-viewer/releases/download/library/library-manifest.json
```

This check does not download the library automatically. When a new manifest
version is available, the application shows its compressed download size and
waits for the user to start the update. It downloads a Zstd-compressed
MessagePack asset, verifies the exact size and SHA-256 digest of both the
compressed asset and the unpacked MessagePack, then imports it through the same
SQLite transaction used by local imports. The active library and installed data
version change only when the complete import commits successfully.

The manifest format is shown in
[`docs/library-manifest.example.json`](docs/library-manifest.example.json):

```json
{
  "manifest_version": 2,
  "version": "2026.09.17.1",
  "format": "messagepack",
  "compression": "zstd",
  "url": "https://github.com/7ARTNE2/nade-viewer/releases/download/data-2026.09.17.1/library.msgpack.zst",
  "compressed_size": 220000000,
  "compressed_sha256": "64 lowercase or uppercase hexadecimal characters",
  "uncompressed_size": 709942607,
  "uncompressed_sha256": "64 lowercase or uppercase hexadecimal characters"
}
```

Publish `library.msgpack.zst` in an immutable versioned data release such as
`data-2026.08.26.1`. Create a separate release with the permanent tag `library`
and upload `library-manifest.json` there. For each data update, replace only the
manifest asset in the `library` release; its `url` points to the new immutable
MessagePack asset. This keeps data releases independent from the application's
`latest` release, which is used by the executable updater.

The unpacked MessagePack asset must contain one of the supported envelopes
documented in [Data formats](docs/data-formats.md). Determine the compressed
and unpacked metadata in PowerShell before publishing:

```powershell
$compressed = Get-Item -LiteralPath ".\library.msgpack.zst"
$compressedSize = $compressed.Length
$compressedSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $compressed.FullName).Hash.ToLowerInvariant()
$uncompressed = Get-Item -LiteralPath ".\library.msgpack"
$uncompressedSize = $uncompressed.Length
$uncompressedSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $uncompressed.FullName).Hash.ToLowerInvariant()
```

The manifest's `url` must be HTTPS and point to the exact `.zst` release asset,
not a mutable branch file. `version` is the data version and is independent of
the application version. Use a new unique value whenever the MessagePack
content changes. Online updates require manifest version 2 and Zstd; manual
imports continue to support JSON, raw MessagePack, and ZIP archives.

One-time manifest release creation and subsequent publication can be done with
GitHub CLI:

```powershell
gh release create library --title "Nade Viewer library manifest" --notes "Stable update manifest endpoint"
gh release create data-2026.09.17.1 ".\library.msgpack.zst" --title "Library 2026.09.17.1" --notes "Nade Viewer data snapshot"
gh release upload library ".\library-manifest.json" --clobber
```

The repository also includes a release helper. It creates `library.msgpack.zst`,
verifies the archive, calculates both SHA-256 digests, and writes the v2
manifest. Add `-Publish` only after inspecting the generated files:

```powershell
.\scripts\publish-library.ps1 -SourcePath .\library.msgpack -Version 2026.09.17.1
.\scripts\publish-library.ps1 -SourcePath .\library.msgpack -Version 2026.09.17.1 -Publish
```

The script uses the installed `zstd` command-line tool when available; otherwise
it uses the bundled Rust compressor. Publishing requires an authenticated
GitHub CLI session. It refuses to replace an existing immutable data release.

For another repository or manifest location, set
`NADE_VIEWER_LIBRARY_MANIFEST_URL` while building the Tauri application. The
value is compiled into that build:

```powershell
$env:NADE_VIEWER_LIBRARY_MANIFEST_URL = "https://example.com/library-manifest.json"
npm run tauri:build
```

Use a new version tag for each release. Check existing local tags with `git tag`
and tags on GitHub with:

```powershell
git ls-remote --tags origin
```

### Run a release manually

To rebuild an existing tag without creating a new one:

1. Open the repository's `Actions` tab on GitHub.
2. Select the `Release` workflow.
3. Click `Run workflow`.
4. Enter an existing tag, for example `v0.7.1`.
5. Click `Run workflow` again.

The manual workflow also requires a tag in the `vMAJOR.MINOR.PATCH` format,
such as `v1.2.3`. Pull requests and normal branch pushes do not publish
installers.

### In-app updates

Installed Windows builds check GitHub Releases shortly after startup and from
the `Check for updates` action in the library menu. Updates are never downloaded
without an explicit install action.

The updater verifies the signed NSIS installer before Windows installs it. The
release workflow publishes the installer signature and `latest.json` manifest
alongside each release. The first release after enabling this feature provides
the update path for later releases.

The signing private key is intentionally stored outside the repository at
`%USERPROFILE%\.tauri\nade-viewer-update.key`. Keep a secure backup: losing it
prevents future updates from being trusted by already-installed copies. GitHub
Actions reads the same key from the repository secret
`TAURI_SIGNING_PRIVATE_KEY` when it builds a release.

## Tests and checks

Run the complete local quality check (formatting, lint, TypeScript, frontend
build, and Rust checks/tests):

```powershell
npm run check
```

Run the same check through the test aggregator:

```powershell
npm test
```

`npm test` also runs the replay browser regressions with deterministic fixtures
and mocked Tauri IPC. Install the test browser once with `npx playwright install chromium`.
Run just these regressions with `npm run test:replay`; an existing Chromium binary
can be selected with `NADE_VIEWER_TEST_BROWSER_PATH`.

Replay regressions cover playback and round navigation, five-second keyboard
seeks and speed changes, killfeed lifetime and fading, kill and grenade previews,
assists, drawing colors, wheel zoom while drawing, the shared Nuke notes editor,
independent floor views at 1920/1280/860 pixels, note filters and links, save
retries, and failed note reads or radar loads. Rust tests separately exercise note persistence across
database connections, atomic writes, validation, and cascading deletion.
CI also checks the separate Go parser with `gofmt`, `go vet`, `go test`, and
`go build` from `plugins/nade-parser`.

Individual quality commands are also available:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run cargo:fmt:check
npm run cargo:check
npm run cargo:test
npm run cargo:clippy -- --all-targets -- -D warnings
```

The isolated Favorites browser regression check uses Playwright and an
in-memory native-command fixture, without accessing the application's database.
With Playwright available, run `node tests/favorites-ui.mjs`. An external
Playwright package directory can be supplied as the first argument. Set
`NADE_VIEWER_TEST_BROWSER` to a supported installed-browser channel, or
`NADE_VIEWER_TEST_BROWSER_PATH` to its executable path, when needed.

Run the Rust unit tests:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

`src/styles.css` is intentionally excluded from Prettier because it is a large
generated-style asset and formatting it would create unrelated churn. CI runs
the same commands on `windows-latest`, matching the supported Tauri toolchain.

## Local data

The application identifier in `src-tauri/tauri.conf.json` is
`app.nadeviewer.desktop`. On Windows, Tauri resolves its application data
directory under roaming application data, so the database is:

```text
%APPDATA%\app.nadeviewer.desktop\nadeviewer.sqlite
```

SQLite may create `nadeviewer.sqlite-wal` and `nadeviewer.sqlite-shm` beside the
database while the application is running. The database contains imports,
lineups, legacy Core flags, view history, onboarding state, and the minimum-usage
setting, usage events, player rosters, and tournament metadata. Deleting an
import in the UI deletes that import's local data; it does not delete the source file.
Favorites and collection membership are stored in the same database, while their
independent screenshots are stored in the adjacent `favorites/` directory. Include
that directory when backing up saved lineups.

### Replay data and notes

Replay uses the **local**, rather than roaming, application data directory:

```text
%LOCALAPPDATA%\app.nadeviewer.desktop\replays.sqlite
```

This database stores parsed match metadata, compressed rounds, playback
positions, text notes, and drawing strokes. Original `.dem` files are not
copied into the database. Close Nade Viewer before copying it for a backup;
while the app runs, SQLite may also keep `replays.sqlite-wal` and
`replays.sqlite-shm` alongside it. Clearing WebView browser storage does not
delete SQLite notes. Removing the database or deleting a match in the app does
remove its notes.

### Nade Parser workspaces

Nade Parser keeps parsing data in two independent SQLite workspaces under
`%LOCALAPPDATA%\app.nadeviewer.desktop`, alongside the replay database:

- `parser-workspace.sqlite` is the `Production` workspace. Existing databases,
  including large libraries, are preserved in place.
- `parser-workspace-test.sqlite` is the isolated `Test` workspace. It is created
  automatically when first opened.

The parser starts in `Test` after every application launch. Select `Production`
only when you intentionally need to work with the existing library. Parsing,
deduplication, and clearing Production require explicit confirmation. Counts,
exports, and parser imports always use the workspace selected in Nade Parser.

Older local databases are migrated automatically on startup. The migration
preserves the old `throw_description` values as `throw_keys` and adds any
missing columns required by the current importer. Close Nade Viewer before
copying or backing up the database; SQLite may also have adjacent `-wal` and
`-shm` files while the application is running.

## Import workflow

1. Start Nade Viewer and open the import screen.
2. Choose a `.json`, `.messagepack`, `.msgpack`, or `.mpk` file, enter its local
   path, or drag it onto the import area.
3. Start the import. JSON and MessagePack files require a top-level
   `canonical_grenades` key.
4. Wait for reading, database preparation, and indexing to complete. The new
   import becomes active automatically.
5. Browse maps, change filters, and inspect individual lineups. Use import
   history to switch, label, or remove snapshots.

Imports are snapshots: importing a file creates a new database import rather
than merging it into the active one. Only one import can run at a time.

## Trajectories and large map results

### Trajectory import

Nade Viewer stores two different trajectory representations:

- `trajectory` is the complete sequence of world-space trajectory points. It is
  retained alongside the preview in local storage.
- `trajectory_preview` is a smaller, radar-space sequence used to draw the path
  efficiently on the map. It can be supplied by the source file or generated
  from `trajectory` when a matching radar config is available.

Both values are stored independently in SQLite. Nade Viewer does not
reconstruct a complete world-space trajectory from preview points.

See [Data formats](docs/data-formats.md) for the exact decoded fields.

### Map rendering

The map overview returns every cluster matching the current filters. Selecting a
cluster loads all of its grenade markers and trajectories for display on the
map. These map requests are not capped or truncated.

The lineup list still shows 30 records per page to keep navigation manageable,
but this pagination does not limit which points or trajectories are rendered on
the map. Very large datasets can therefore require more query, IPC, memory, and
rendering work; use filters when a less crowded view is preferable.

## Maps and radar assets

Bundled previews, radar images, and radar coordinate configs currently cover:

- Ancient (`de_ancient`)
- Anubis (`de_anubis`)
- Cache (`de_cache`)
- Dust II (`de_dust2`)
- Inferno (`de_inferno`)
- Mirage (`de_mirage`)
- Nuke (`de_nuke`)
- Overpass (`de_overpass`)
- Train (`de_train`)
- Vertigo (`de_vertigo`)

Nuke and Vertigo also have lower-level radar images. The application only
enables lower-level switching when both a lower image and a lower altitude
boundary exist. The lineup workspace uses that switch on both maps; Nuke
replay instead displays the two floors simultaneously.

The authoritative asset inventory is the repository itself:

- `src-tauri/resources/maps/2d/` for radar images
- `src-tauri/resources/maps/preview/` for map previews
- `src-tauri/resources/radar_configs/` for coordinate transforms and level
  boundaries
- `src-tauri/resources/spawn_points.json` for spawn positions

Map names present in imported data are still added to the library, but a map
without matching bundled assets/config can lack a preview, radar background,
coordinate projection, and level handling. Asset discovery extracts a
`de_<name>` key from filenames; radar config filenames must match that key.

## Troubleshooting

### Unsupported library format

JSON and MessagePack files require `canonical_grenades`; files with a root
`grenades` key or `core_nades: true` are unsupported. Check the envelope and
required fields against [Data formats](docs/data-formats.md).

### A serde error names a missing field or invalid type

Decoded field types are strict. In particular, `map` is required for canonical
records.
Numeric fields must be decoded as numbers, not numeric strings.

### A map is listed but has no radar or markers

The imported map name must normalize to the matching `de_<name>` radar config.
Projection also needs both X and Y world coordinates. Verify the corresponding
files under `src-tauri/resources/` and the position fields in the JSON.

### Lower radar is unavailable

Both a lower radar image and a `lower` block containing `AltitudeMax` in the
radar config are required. The bundled lower-level support is currently limited
to Nuke and Vertigo.

### The desktop build cannot find a compiler or Windows SDK

Confirm that the Rust MSVC toolchain and the Visual Studio C++ workload with a
Windows SDK are installed. Run the command from a Developer PowerShell if the
native toolchain is not visible in the current shell.

### The window is blank or fails to start

Install or repair the Microsoft Edge WebView2 Runtime, then rerun
`npm run tauri:dev`.

## Limitations

- The application is configured and bundled for Windows installers.
- It reads local JSON and MessagePack snapshots; it does not fetch or refresh an online index.
- Imported unknown fields are ignored by Serde, so a successful import does
  not imply that every source field is used.
- Values are structurally type-checked but domain values such as map names,
  sides, grenade types, timestamps, coordinate ranges, and positive counts are
  not comprehensively validated during import.
- Radar coordinates and trajectory previews depend on a matching bundled radar
  config.

## License

This repository does not currently contain a license file. No license is
asserted here.
