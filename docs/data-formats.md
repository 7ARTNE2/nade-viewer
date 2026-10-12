# Input library formats

## Nadegrid Screenshot Capture archive

NadeViewer imports the ZIP produced by Nadegrid's
`Tools > Screenshot Capture > Export ZIP` action. The archive must contain a
version 1 `grenades.json` manifest and the referenced normal and wide-FOV JPEG
files under `screenshots/`. Importing it creates a separate local library and
stores its images alongside the NadeViewer database. Both lineup views appear
on the grenade detail page.

This document describes only formats implemented by the import code in
`src-tauri/src/lib.rs`. No external schema or data source is assumed.

## Online library updates

Online updates use manifest version 2 (`docs/library-manifest.example.json`).
The asset is a Zstd-compressed MessagePack stream. NadeViewer verifies the
downloaded compressed size and SHA-256 before opening it, then streams the
decompressed records directly into one uncommitted SQLite transaction while
counting and hashing the uncompressed bytes. It commits and activates the new
library only after the entire Zstd stream, MessagePack payload, uncompressed
size, and uncompressed SHA-256 have all been verified. A failure or cancellation
leaves the existing active library and library-version metadata unchanged.

The online payload is intentionally narrower than manual imports: it must be
the definite-size MessagePack envelope written by `parser_store::write_msgpack`:
a two-entry root map with `version` first (integer `1`) and
`canonical_grenades` second (a definite-size array). Manual JSON, raw
MessagePack, and ZIP imports continue to accept the broader formats documented
below.

For library imports, Nade Viewer expects a UTF-8 object for JSON files. A file with a
`.messagepack`, `.msgpack`, or `.mpk` extension is decoded as MessagePack;
other non-ZIP library files are decoded as JSON. After decoding, JSON and
MessagePack use the same format detection, defaults, and local database
conversion rules.

The format is detected as follows:

- A top-level `canonical_grenades` key selects the canonical parser.
- Otherwise, the file is rejected as unsupported.

The root must be an object with a `canonical_grenades` key. Files with a
top-level `grenades` key or `core_nades: true` are rejected as unsupported.
Serde ignores other unknown fields.
A field marked optional below may be omitted or set to `null`; a required field
must be present and must not be `null`.

## Canonical grenade_index

The canonical envelope maps to `ParserIndex`, and each entry maps to
`RawGrenade`.

### Envelope fields

| Field                | JSON type                   | Required | Meaning                                                                                                                                                                                             |
| -------------------- | --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | integer                     | No       | Parser/index version stored with the import. If present and non-null, it must be the supported version `1`; other versions are rejected with the supplied and supported versions in the diagnostic. |
| `updated_at`         | string                      | No       | Parser/index update text stored with the import; the importer does not validate a timestamp format.                                                                                                 |
| `canonical_grenades` | array of canonical records  | Yes      | Records to import; an empty array is valid.                                                                                                                                                         |
| `players`            | array or nested player maps | No       | Player metadata for the import. The importer flattens ordinary arrays and supported nested demo/SteamID/team maps.                                                                                  |
| `processed_demos`    | any JSON value              | No       | Optional processed-demo metadata. The importer recursively scans it for recognized demo filenames and optional `tournament` values.                                                                 |

### Canonical record fields

| Field                | JSON type                  | Required | Meaning                                                                                                                                          |
| -------------------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `map`                | string                     | Yes      | Map name. It is stored exactly as supplied; radar lookup lowercases it and adds `de_` if absent.                                                 |
| `side`               | string                     | No       | Side label; defaults to `"Any"`.                                                                                                                 |
| `grenade_type`       | string                     | No       | Grenade type; defaults to `"smoke"`.                                                                                                             |
| `throw_keys`         | string                     | No       | Human-readable throw instructions or key sequence.                                                                                               |
| `usage_count`        | integer                    | No       | Usage frequency; defaults to `1`.                                                                                                                |
| `usage_throwers`     | array of strings           | No       | Players associated with uses; defaults to an empty array.                                                                                        |
| `usage_events`       | array of event objects     | No       | Detailed usage events; defaults to an empty array. See [Usage events](#usage-events).                                                            |
| `coordinates`        | string                     | No       | Source coordinate/position text displayed by the application.                                                                                    |
| `demo_filename`      | string                     | No       | Source demo filename.                                                                                                                            |
| `tournament`         | string                     | No       | Explicit tournament name used for demo metadata when supplied; otherwise it can be derived from the demo filename.                               |
| `throw_tick`         | integer                    | No       | Tick at which the grenade was thrown.                                                                                                            |
| `lineup_tick`        | integer                    | No       | Tick for the lineup position.                                                                                                                    |
| `tickrate`           | number                     | No       | Demo tick rate. Fractional values are accepted and rounded to the nearest integer when stored in the local database.                             |
| `round_time_seconds` | number                     | No       | Time within the round.                                                                                                                           |
| `start_pos_x`        | number                     | No       | Throw origin X in game/world coordinates.                                                                                                        |
| `start_pos_y`        | number                     | No       | Throw origin Y in game/world coordinates.                                                                                                        |
| `start_pos_z`        | number                     | No       | Throw origin Z in game/world coordinates.                                                                                                        |
| `explode_pos_x`      | number                     | No       | Detonation/landing X in game/world coordinates.                                                                                                  |
| `explode_pos_y`      | number                     | No       | Detonation/landing Y in game/world coordinates.                                                                                                  |
| `explode_pos_z`      | number                     | No       | Detonation/landing Z, also used to choose a radar level.                                                                                         |
| `trajectory`         | array of arrays of numbers | No       | World-space trajectory points. Each point needs at least X and Y to appear in the sampled map preview; additional values such as Z are retained. |
| `thrower`            | string                     | No       | Primary player/thrower name.                                                                                                                     |
| `thrower_steamid64`  | string or number           | No       | Primary thrower's SteamID64. Numeric input is converted to text.                                                                                 |
| `thrower_team`       | string                     | No       | Primary thrower's team.                                                                                                                          |
| `airtime`            | number                     | No       | Grenade airtime. No unit conversion or range validation is applied.                                                                              |

All numeric fields must be numbers in the decoded JSON or MessagePack value.
Integer fields do not accept decimal values, except for `tickrate`, which may
be fractional and is rounded before insertion into the local database. Optional
position pairs are only projected to radar coordinates when a matching radar
config exists and both X and Y are present.

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
      "throw_keys": "Jump throw",
      "usage_count": 3,
      "usage_throwers": ["Player One"],
      "thrower": "Player One",
      "thrower_steamid64": "76561198000000001",
      "thrower_team": "Example",
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
  ],
  "players": [
    {
      "demo_filename": "Example_match_2026-07-18.dem",
      "steamid64": "76561198000000001",
      "name": "Player One",
      "team_name": "Example",
      "side": "T"
    }
  ],
  "processed_demos": [{ "demo_filename": "Example_match_2026-07-18.dem" }]
}
```

The timestamp above demonstrates a string commonly suitable for the metadata;
the importer itself accepts any string in `updated_at`.

For recognized demo metadata, the date must be a `YYYY-MM-DD` value in the demo
filename. Without an explicit `tournament` value, the tournament name is the
non-empty prefix before the first `_`. An explicit value takes precedence for
that filename. Metadata is collected from grenade and usage event filenames,
player filenames, and canonical `processed_demos` values.

### Usage events

`usage_events` stores one object per tracked throw. All event fields are
optional:

| Field               | JSON type        | Meaning                                                                   |
| ------------------- | ---------------- | ------------------------------------------------------------------------- |
| `demo_filename`     | string           | Demo containing the throw.                                                |
| `throw_tick`        | integer          | Tick of the throw. The input alias `tick` is also accepted.               |
| `thrower`           | string           | Thrower name. Input aliases `player` and `player_name` are also accepted. |
| `thrower_steamid64` | string or number | Thrower's SteamID64. The input alias `steamid64` is also accepted.        |
| `thrower_team`      | string           | Thrower's team. Input aliases `team` and `team_name` are also accepted.   |

Example:

```json
{
  "usage_events": [
    {
      "demo_filename": "Alpha_match_2026-07-18.dem",
      "throw_tick": 12345,
      "thrower": "Player One",
      "thrower_steamid64": "76561198000000001",
      "thrower_team": "Alpha"
    }
  ]
}
```

When events are present, the interface derives tracked usage statistics from
the events; otherwise it falls back to `usage_count` and the summary thrower
fields.

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
- Demo tournament metadata is created only when the filename has a non-empty
  prefix before `_` and a recognizable `YYYY-MM-DD` date.

## Radar-dependent behavior

Coordinate conversion uses the matching file in
`src-tauri/resources/radar_configs/`:

```text
map_x = (game_x - pos_x) / scale
map_y = (pos_y - game_y) / scale
```

Without a matching config, canonical world positions do not produce map
coordinates. Canonical trajectory preview points then remain in world X/Y space,
which generally does not align with the 1024-unit radar canvas. A canonical
record can provide `trajectory_preview` as precomputed data.

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
- `trajectory_preview` in canonical records is accepted without
  structural validation and takes precedence over generated preview data.
- Strings are not trimmed or normalized during record import.
- There is no comprehensive validation for timestamp syntax, supported map,
  side/type vocabulary, finite/ranged coordinates, positive tick rates, or
  positive usage counts.
- A syntactically and structurally valid empty records array imports
  successfully as a zero-grenade snapshot.
