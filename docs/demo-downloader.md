# Demo downloads

The built-in **Tools → Demo Downloader** uses the Windows WebView2 runtime
already required by Tauri. It does not install Chromium, Node.js or Python.
7-Zip 25.01 (`7z.exe`, `7z.dll`, and its license) is bundled in
`src-tauri/resources/runtime/7zip`. The original, unmodified binaries can be
obtained from <https://www.7-zip.org/>; source distributions are available there.

The catalog reads HLTV's event archive and ongoing event list through a separate
browser profile. The main application alone can invoke native commands; the
remote HLTV window has no application command access. Page extraction returns
JSON through a navigation that is intercepted locally and never sent to a server.

## Catalog

The local SQLite cache is under the application's data directory in
`demo-downloader/catalog.sqlite`. It also stores queue metadata and output file
paths. On opening the tool, the cache is displayed immediately; if older than six
hours, it is refreshed. Refresh is also available manually. Failed refreshes do
not replace the cached catalog.

Date filters refer to **the final day of the tournament**, inclusive. Empty dates
load the latest 92 days. Prize bounds refer to the amount reported by HLTV, which
may include club compensation; available player/club shares appear in a tooltip.
The catalog shows missing amounts as unknown rather than zero. Change date/prize
ranges and press Update to fetch a different range. Search, type and status
filters and sorting operate locally. Catalog pagination is bounded to 100 pages;
an incomplete listing is indicated in the UI.

## Files and recovery

Downloads run sequentially. Tournament URLs are expanded into completed matches;
repeating a tournament checks its results again, allowing ongoing events to gain
new demos. Successful matches with all output files still present in the chosen
destination are skipped. Changed destinations or missing files require another
download. Match and tournament identity uses HLTV IDs rather than URL slugs.

The selected destination holds `.nadeviewer-downloads/matches-ID/` while a match
is being processed. Only a completed browser download is reusable as an archive.
7-Zip extracts once and checks checksums during extraction; there is no separate
`7z t`. All extracted demo headers are checked for CS2 before saving. Names are
`Tournament_originalStem_localMatchDate.dem`; multipart suffixes are retained.
Names already present are preserved and the new file receives `_dupN`.

The successful file list is persisted before removing the archive and extraction
directory. An extraction failure retains the archive; Continue retries it. An
interrupted network download is downloaded again (byte-range resume is not
implemented). No parser starts automatically. Stop interrupts the queue and
closes the browser download session. Closing NadeViewer also ends the downloader;
Continue is available after reopening it.

HLTV can change its markup or require a browser check. The tool exposes its HLTV
window and shows detected checks to the user; it does not solve CAPTCHAs or
circumvent access controls. A failed page stops the queue rather than issuing
rapid retries.

## Validation

`npm run test:downloader` checks the frontend with mocked native IPC: filtering,
selection, destination, start/stop, and a narrow window. Rust unit tests cover URL
restrictions, ID deduplication and filename handling. Live download checks must
use a separate destination **outside `dist/`**: Vite clears `dist` on builds.
