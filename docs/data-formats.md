# Input library formats

## Nadegrid Screenshot Capture archive

NadeViewer imports the ZIP produced by Nadegrid's **Tools > Screenshot Capture
> Export ZIP** action. The archive must contain a version 1 `grenades.json`
manifest and the referenced normal and wide-FOV JPEG files under
`screenshots/`. Importing it creates a separate local library and stores its
images alongside the NadeViewer database. Both lineup views appear on the
grenade detail page.

This document describes only formats implemented by the import code in
`src-tauri/src/lib.rs`. No external schema or data source is assumed.

For JSON imports, Nade Viewer expects a UTF-8 object and detects the format as
follows:

- A top-level `canonical_grenades` key selects the canonical parser.
- A top-level `grenades` key selects the Core Nades parser.
- Otherwise, the file is rejected as unsupported.

The root must be an object and exactly one of these format keys must be present;
a file containing both is rejected as ambiguous. Serde ignores unknown fields.
A field marked optional below may be omitted or set to `null`; a required field
must be present and must not be `null`.

## Canonical grenade_index

The canonical envelope maps to `ParserIndex`, and each entry maps to
`RawGrenade`.

### Envelope fields

| Field                | JSON type                  | Required | Meaning                                                                                                                                                                                             |
| -------------------- | -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | integer                    | No       | Parser/index version stored with the import. If present and non-null, it must be the supported version `1`; other versions are rejected with the supplied and supported versions in the diagnostic. |
| `updated_at`         | string                     | No       | Parser/index update text stored with the import; the importer does not validate a timestamp format.                                                                                                 |
| `core_nades`         | boolean                    | No       | Defaults to `false`. When `true`, the import is classified as `core_nades` and every imported record starts with its Core flag set.                                                                 |
| `canonical_grenades` | array of canonical records | Yes      | Records to import; an empty array is valid.                                                                                                                                                         |

### Canonical record fields

| Field                | JSON type                  | Required | Meaning                                                                                                                                          |
| -------------------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `map`                | string                     | Yes      | Map name. It is stored exactly as supplied; radar lookup lowercases it and adds `de_` if absent.                                                 |
| `side`               | string                     | No       | Side label; defaults to `"Any"`.                                                                                                                 |
| `grenade_type`       | string                     | No       | Grenade type; defaults to `"smoke"`.                                                                                                             |
| `throw_description`  | string                     | No       | Human-readable throw instructions.                                                                                                               |
| `usage_count`        | integer                    | No       | Usage frequency; defaults to `1`.                                                                                                                |
| `usage_throwers`     | array of strings           | No       | Players associated with uses; defaults to an empty array.                                                                                        |
| `coordinates`        | string                     | No       | Source coordinate/position text displayed by the application.                                                                                    |
| `demo_filename`      | string                     | No       | Source demo filename.                                                                                                                            |
| `throw_tick`         | integer                    | No       | Tick at which the grenade was thrown.                                                                                                            |
| `lineup_tick`        | integer                    | No       | Tick for the lineup position.                                                                                                                    |
| `tickrate`           | integer                    | No       | Demo tick rate.                                                                                                                                  |
| `round_time_seconds` | number                     | No       | Time within the round.                                                                                                                           |
| `start_pos_x`        | number                     | No       | Throw origin X in game/world coordinates.                                                                                                        |
| `start_pos_y`        | number                     | No       | Throw origin Y in game/world coordinates.                                                                                                        |
| `start_pos_z`        | number                     | No       | Throw origin Z in game/world coordinates.                                                                                                        |
| `explode_pos_x`      | number                     | No       | Detonation/landing X in game/world coordinates.                                                                                                  |
| `explode_pos_y`      | number                     | No       | Detonation/landing Y in game/world coordinates.                                                                                                  |
| `explode_pos_z`      | number                     | No       | Detonation/landing Z, also used to choose a radar level.                                                                                         |
| `trajectory`         | array of arrays of numbers | No       | World-space trajectory points. Each point needs at least X and Y to appear in the sampled map preview; additional values such as Z are retained. |
| `thrower`            | string                     | No       | Primary player/thrower name.                                                                                                                     |
| `airtime`            | number                     | No       | Grenade airtime. No unit conversion or range validation is applied.                                                                              |

All numeric fields must be JSON numbers. Integer fields do not accept decimal
values. Optional position pairs are only projected to radar coordinates when a
matching radar config exists and both X and Y are present.

### Minimal canonical example

```json
{
  "canonical_grenades": [
    {
      "map": "Mirage"
    }
  ]
}
```

This imports one `Mirage` smoke with side `Any` and usage count `1`. It has no
map marker because no start or explosion coordinates were provided.

### Canonical example with map data

```json
{
  "version": 1,
  "updated_at": "2026-07-18T12:00:00Z",
  "canonical_grenades": [
    {
      "map": "Mirage",
      "side": "T",
      "grenade_type": "smoke",
      "throw_description": "Jump throw",
      "usage_count": 3,
      "usage_throwers": ["Player One"],
      "start_pos_x": -1600.5,
      "start_pos_y": 400.0,
      "start_pos_z": -120.0,
      "explode_pos_x": 250.0,
      "explode_pos_y": -900.0,
      "explode_pos_z": 25.0,
      "trajectory": [
        [-1600.5, 400.0, -120.0],
        [250.0, -900.0, 25.0]
      ]
    }
  ]
}
```

The timestamp above demonstrates a string commonly suitable for the metadata;
the importer itself accepts any string in `updated_at`.

## Core Nades formats

The application accepts two representations of a Core collection.

### Core Nades snapshot envelope

A root `grenades` key selects `CoreNadesFile`. Unlike the canonical format, the
three identifying fields on every record are required.

| Envelope field | JSON type             | Required | Meaning                                                                                                                                                  |
| -------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | integer               | Yes      | Snapshot version, stored as the import parser version. It must be integer `1`; missing, non-integer, and unsupported versions have distinct diagnostics. |
| `exported_at`  | string                | Yes      | Export metadata stored with the import; no timestamp syntax is validated.                                                                                |
| `grenades`     | array of Core records | Yes      | Records to import; an empty array is valid.                                                                                                              |

| Core record field                                 | JSON type                  | Required | Meaning                                                                                                                                                           |
| ------------------------------------------------- | -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_index`                                    | integer                    | No       | Original record index; defaults to the record's zero-based array position.                                                                                        |
| `map`                                             | string                     | Yes      | Map name.                                                                                                                                                         |
| `side`                                            | string                     | Yes      | Side label. There is no default in this format.                                                                                                                   |
| `grenade_type`                                    | string                     | Yes      | Grenade type. There is no default in this format.                                                                                                                 |
| `throw_description`                               | string                     | No       | Human-readable throw instructions.                                                                                                                                |
| `coordinates`                                     | string                     | No       | Source coordinate/position text.                                                                                                                                  |
| `thrower`                                         | string                     | No       | Primary player/thrower name.                                                                                                                                      |
| `airtime`                                         | number                     | No       | Grenade airtime.                                                                                                                                                  |
| `usage_count`                                     | integer                    | No       | Usage frequency; defaults to `1`.                                                                                                                                 |
| `usage_throwers`                                  | array of strings           | No       | Players associated with uses; defaults to an empty array.                                                                                                         |
| `demo_filename`                                   | string                     | No       | Source demo filename.                                                                                                                                             |
| `throw_tick`                                      | integer                    | No       | Throw tick.                                                                                                                                                       |
| `lineup_tick`                                     | integer                    | No       | Lineup tick.                                                                                                                                                      |
| `tickrate`                                        | integer                    | No       | Demo tick rate.                                                                                                                                                   |
| `round_time_seconds`                              | number                     | No       | Time within the round.                                                                                                                                            |
| `start_pos_x`, `start_pos_y`, `start_pos_z`       | number                     | No       | Throw origin in game/world coordinates.                                                                                                                           |
| `explode_pos_x`, `explode_pos_y`, `explode_pos_z` | number                     | No       | Detonation/landing position in game/world coordinates.                                                                                                            |
| `start_map_x`, `start_map_y`                      | number                     | No       | Precomputed throw-origin radar coordinates, used only when world X/Y cannot be projected.                                                                         |
| `explode_map_x`, `explode_map_y`                  | number                     | No       | Precomputed landing radar coordinates, used only when world X/Y cannot be projected.                                                                              |
| `trajectory`                                      | array of arrays of numbers | No       | Full world-space trajectory. It is retained unchanged for canonical Core re-export and is used to generate a sampled preview when `trajectory_preview` is absent. |
| `trajectory_preview`                              | any JSON value             | No       | Precomputed preview stored as-is. The UI expects point-like data, but import performs no shape validation.                                                        |

When both world X/Y and precomputed map X/Y exist, successfully projected world
coordinates take precedence. Every record imported through this envelope is
marked Core. When both trajectory fields exist, `trajectory_preview` is used
as-is by the UI and `trajectory` remains the lossless export source. When only
`trajectory` exists, the importer derives the UI preview using the same sampling
and radar projection as a canonical import. A preview-only legacy record remains
valid and keeps its preview, but no full trajectory is inferred from map-space
preview points.

### Minimal Core Nades snapshot

```json
{
  "version": 1,
  "exported_at": "2026-07-18T12:00:00Z",
  "grenades": [
    {
      "map": "Nuke",
      "side": "CT",
      "grenade_type": "flashbang"
    }
  ]
}
```

### Canonical Core envelope

A canonical file can also represent Core Nades by setting `core_nades` to
`true`. It uses exactly the `ParserIndex` and `RawGrenade` fields documented
above:

```json
{
  "version": 1,
  "core_nades": true,
  "canonical_grenades": [
    {
      "map": "Nuke",
      "side": "CT",
      "grenade_type": "flashbang"
    }
  ]
}
```

This is also the envelope currently written by Nade Viewer's Core export action.
The export sets `version` to `1`, sets `updated_at` to the current UTC timestamp,
sets `core_nades` to `true`, and includes only records marked Core in the active
import. Canonical records additionally accept optional `trajectory_preview` with
the same type and behavior documented for snapshot records. Export includes the
stored full `trajectory` and stored `trajectory_preview`, so either representation
survives another import/export cycle. Missing fields are serialized as `null`,
consistent with the other optional canonical record fields.

## Values used by the interface

Serde validates JSON types but does not restrict most string values. The UI and
query code have these conventions:

- Side filters recognize `T`, `CT`, and `Any`; other strings import but may not
  behave like those conventional values.
- The bundled grenade icons cover `smoke`, `flashbang`, `hegrenade`, and
  `molotov`. Other type strings can import without a matching dedicated icon.
- Map lookup is case-insensitive for radar config selection and adds `de_` when
  needed. For example, `Mirage` maps to `de_mirage` and `de_dust2` remains
  `de_dust2`.
- Imported map names themselves are stored as supplied. Inconsistent spellings
  or prefixes can therefore produce separate map entries even if they normalize
  to the same asset key.
- `usage_count` defaults to `1`. The visibility setting is clamped from 1 to 50,
  so zero or negative imported counts can be hidden.

## Radar-dependent behavior

Coordinate conversion uses the matching file in
`src-tauri/resources/radar_configs/`:

```text
map_x = (game_x - pos_x) / scale
map_y = (pos_y - game_y) / scale
```

Without a matching config, canonical world positions do not produce map
coordinates. Canonical trajectory preview points then remain in world X/Y space,
which generally does not align with the 1024-unit radar canvas. Core snapshot
records can provide `start_map_*`, `explode_map_*`, and `trajectory_preview` as
fallback precomputed data.

The currently bundled configs are `de_ancient`, `de_anubis`, `de_cache`,
`de_dust2`, `de_inferno`, `de_mirage`, `de_nuke`, `de_overpass`, `de_train`, and
`de_vertigo`. Consult the directory rather than treating this list as a format
restriction: records for other maps are accepted, but bundled visual support is
not guaranteed.

## Import behavior and limitations

- Importing creates a new snapshot and makes it active; it does not update or
  deduplicate an existing import.
- The map count is the count of distinct `map` strings, with exact spelling and
  case.
- Canonical records receive a zero-based `source_index` based on array order.
- When no explicit preview exists, trajectory preview generation samples at most
  approximately 64 regularly spaced points and ignores trajectory entries with
  fewer than two numbers.
- `trajectory_preview` in either Core representation is accepted without
  structural validation and takes precedence over generated preview data.
- Strings are not trimmed or normalized during record import.
- There is no comprehensive validation for timestamp syntax, supported map,
  side/type vocabulary, finite/ranged coordinates, positive tick rates, or
  positive usage counts.
- A syntactically and structurally valid empty records array imports
  successfully as a zero-grenade snapshot.
