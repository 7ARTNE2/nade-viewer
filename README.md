# Nade Viewer

Nade Viewer is a Windows desktop application for browsing Counter-Strike grenade
lineups from local JSON files. It imports lineups into a local SQLite database
and presents them on bundled radar images; no server or network data source is
configured in this repository.

## Features

- Imports canonical `grenade_index` and Core Nades JSON snapshots.
- Keeps multiple imports, lets the user switch between them, rename them, and
  delete them.
- Groups grenade starts and landings on map radars.
- Filters by grenade type, side, usage count, radar level, Core status, and text.
- Shows trajectories, lineup metadata, similar grenades, spawn points, and
  recently viewed grenades when the source data supports them.
- Marks selected lineups as Core and exports the current Core collection.
- Stores imported data and settings locally in SQLite.
- Provides English and Russian interfaces.

The accepted JSON structures, field requirements, examples, and import
limitations are documented in [Data formats](docs/data-formats.md).

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

## Tests and checks

Run the Rust unit tests:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

Useful repository checks are:

```powershell
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

There is currently no JavaScript test script in `package.json`.

## Local data

The application identifier in `src-tauri/tauri.conf.json` is
`app.nadeviewer.desktop`. On Windows, Tauri resolves its application data
directory under roaming application data, so the database is:

```text
%APPDATA%\app.nadeviewer.desktop\nadeviewer.sqlite
```

SQLite may create `nadeviewer.sqlite-wal` and `nadeviewer.sqlite-shm` beside the
database while the application is running. The database contains imports,
lineups, Core flags, view history, onboarding state, and the minimum-usage
setting. Deleting an import in the UI deletes that import's lineups and view
history; it does not delete the original JSON file.

## Import workflow

1. Start Nade Viewer and open the import screen.
2. Choose a `.json` file, enter its local path, or drag it onto the import area.
3. Start the import. The application detects the format by the top-level
   `canonical_grenades` or `grenades` key.
4. Wait for reading, database preparation, and indexing to complete. The new
   import becomes active automatically.
5. Browse maps, change filters, and inspect individual lineups. Use import
   history to switch, label, or remove snapshots.
6. Optionally mark lineups as Core and use the export action to write
   `core_nades.json`.

Imports are snapshots: importing a file creates a new database import rather
than merging it into the active one. Only one import can run at a time.

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
boundary exist.

The authoritative asset inventory is the repository itself:

- `src-tauri/resources/maps/2d/` for radar images
- `src-tauri/resources/maps/preview/` for map previews
- `src-tauri/resources/radar_configs/` for coordinate transforms and level
  boundaries
- `src-tauri/resources/spawn_points.json` for spawn positions

Map names present in imported JSON are still added to the library, but a map
without matching bundled assets/config can lack a preview, radar background,
coordinate projection, and level handling. Asset discovery extracts a
`de_<name>` key from filenames; radar config filenames must match that key.

## Troubleshooting

### `Unsupported JSON`

The root object has neither `canonical_grenades` nor `grenades`. Check the
envelope and required fields against [Data formats](docs/data-formats.md).

### A serde JSON error names a missing field or invalid type

JSON field types are strict. In particular, `map` is required for canonical
records, while Core Nades records require `map`, `side`, and `grenade_type`.
Numbers must be JSON numbers, not numeric strings.

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
- It reads local JSON snapshots; it does not fetch or refresh an online index.
- Imported unknown JSON fields are ignored by Serde, so a successful import does
  not imply that every source field is used.
- Values are structurally type-checked but domain values such as map names,
  sides, grenade types, timestamps, coordinate ranges, and positive counts are
  not comprehensively validated during import.
- Core Nades has two accepted envelopes, with different available trajectory
  data; see [Data formats](docs/data-formats.md#core-nades-formats).
- Radar coordinates and trajectory previews depend on a matching bundled radar
  config.

## License

This repository does not currently contain a license file. No license is
asserted here.
