# Nade Viewer Plugins

Plugins are installed per-user in `%LOCALAPPDATA%\\NadeViewer\\plugins`.

## Nade Parser

Install the Go parser as:

```text
%LOCALAPPDATA%\\NadeViewer\\plugins\\nade-parser\\nade-parser.exe
```

The executable must support `--plugin-info`, returning JSON with `name`,
`version`, and `protocol_version` fields. Parsing is invoked with:

```text
nade-parser.exe --parse --demo <demo> --output <result.json>
```

The result uses the existing Nade Viewer grenade-index import format.
