# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The product is distributed as a Windows desktop application through Tauri. Its
interface runs in WebView2 and is designed primarily for mouse and keyboard
use in desktop windows.

## Users

- Counter-Strike 2 players preparing and practicing grenade lineups.
- Coaches and analysts researching imported lineup data and curating Core
  collections for teams.

## Product Purpose

Nade Viewer imports local grenade lineup JSON snapshots into a local SQLite
database. Users browse maps, filter and inspect lineups, study trajectories,
copy coordinates, and maintain a curated Core collection without sending data
to a server.

## Positioning

Nade Viewer is a local-first Windows workspace for exploring CS2 grenade
lineups on bundled tactical radar images. It supports both quick player lookup
and deeper analyst workflows across imported library snapshots.

## Operating Context

Users work from local grenade_index and Core Nades JSON files, often while
preparing for a match, reviewing demos, or building team playbooks. Primary
flows are import a library, choose a map, narrow lineups, inspect a grenade,
and copy a console-ready coordinate command or mark it as Core.

## Capabilities and Constraints

- Windows desktop distribution through Tauri 2 with a React and TypeScript
  frontend plus Rust IPC and SQLite storage.
- No HTTP backend, accounts, cloud sync, or network data source.
- English and Russian interfaces.
- Bundled radar assets currently cover ten CS2 maps, with lower-radar support
  where assets and coordinate configuration exist.
- Large imported libraries can contain many map markers and trajectories, so
  filtering and scanability are essential to perceived performance.

## Brand Commitments

- Product name: Nade Viewer.
- Local-first, technical, tactical product character.
- Existing radar-map and gaming context must remain recognizable during UI
  improvements.

## Evidence on Hand

- Product behavior and technical constraints: `README.md`.
- Frontend routes and UI flows: `src/App.tsx`, `src/pages/`, and
  `src/components/`.
- Bundled radar, map-preview, icon, and Orbitron font assets:
  `src-tauri/resources/`.
- No customer testimonials, market claims, remote data, or online content may
  be fabricated.

## Product Principles

- Keep the next useful lineup visible and actionable with minimal detours.
- Preserve local ownership of libraries and player data.
- Support rapid lookup and deep tactical analysis in the same workspace.
- Make high-density map data understandable through progressive disclosure.
- Give every important operation explicit, localized feedback.

## Accessibility & Inclusion

- Preserve keyboard operation, visible focus, readable contrast, and
  `prefers-reduced-motion` support.
- Treat Russian text expansion as a first-class desktop layout constraint.
