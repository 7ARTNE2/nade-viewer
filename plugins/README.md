# Nade Viewer Plugins

Plugins are installed per-user in
`%LOCALAPPDATA%\app.nadeviewer.desktop\plugins`.

## Nade Parser

Install the Go parser as:

```text
%LOCALAPPDATA%\app.nadeviewer.desktop\plugins\nade-parser\nade-parser.exe
```

The executable must support `--plugin-info`, returning JSON with `name`,
`version`, and `protocol_version` fields. Parsing is invoked with:

```text
nade-parser.exe --parse --demo <demo> --output <result.json>
```

The result uses the existing Nade Viewer grenade-index import format.

Replay support requires Nade Parser 0.3.0 or newer with the `replay_v1`
capability. Existing saved matches can be played without the plugin.
See the [parser README](nade-parser/README.md) for build instructions and the
replay stream format. The plugin is distributed and versioned separately from
the Viewer application.
