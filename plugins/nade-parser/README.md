# Nade Parser Plugin

Independent source copy of the Nadegrid Go parser. Building does not require
the Nadegrid checkout. The executable is distributed separately from Viewer.

Build from this directory with Go 1.25 or newer:

```powershell
go test ./...
go build -o nade-parser.exe ./cmd/nade-parser
```

Protocol:

```text
nade-parser.exe --plugin-info
nade-parser.exe --parse --demo match.dem --output result.json
```

The output contains version 1 canonical_grenades, including dense trajectories.
The CLI does not deduplicate throws. Tools optionally applies Viewer Rust
deduplication to the combined output before publishing it.

Tools accepts a single `.dem` file or multiple folders through a native
multi-folder picker. Selected paths can be removed before starting. Folder
discovery is recursive, case-insensitive for `.dem`, sorted by canonical path,
and deduplicates overlapping paths (including canonical aliases). Directory
cycles are visited only once. Non-demo files inside folders are ignored;
missing inputs, unreadable entries, invalid explicit files and empty selections
fail explicitly. Hard-linked files with distinct canonical paths remain distinct.

Viewer invokes this CLI once per file with separate process arguments, never
a shell or the Go directory parser (which can swallow per-file failures).
Progress reports scanning, actual completed demos / total, and finalization.
Only one job runs at a time. Any subprocess, JSON, metadata conflict or write
failure aborts the job without publishing partial results; the previous result
remains available. Errors identify the failing demo where applicable.
Canonical grenade objects and compatible root metadata are preserved while
combining results. JSON/MessagePack export and explicit Viewer import use that
same combined result. No valid demo fixture is bundled for end-to-end parsing.
