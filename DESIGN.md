---
name: Nade Viewer
description: Local-first tactical workspace for Counter-Strike 2 grenade lineups.
colors:
  background: '#0a0c0f'
  surface: '#111419'
  surface-raised: '#171b21'
  surface-active: '#1d222a'
  line: '#272c34'
  text: '#f4f6f8'
  muted: '#89929f'
  dim: '#5f6875'
  primary: '#c8f43d'
  warning: '#ff7447'
  info: '#65a7ff'
  danger: '#ff5e68'
typography:
  display:
    fontFamily: 'Orbitron, sans-serif'
    fontWeight: 800
    lineHeight: 0.96
    letterSpacing: '-0.06em'
  body:
    fontFamily: 'Inter, Segoe UI, sans-serif'
    fontWeight: 400
  label:
    fontFamily: 'Inter, Segoe UI, sans-serif'
    fontWeight: 800
    letterSpacing: '0.08em'
rounded:
  small: '7px'
  control: '9px'
  panel: '12px'
  dialog: '14px'
spacing:
  compact: '8px'
  control: '12px'
  panel: '15px'
  page: '30px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '#111606'
    rounded: '{rounded.control}'
    height: '38px'
  button-secondary:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.text}'
    rounded: '{rounded.control}'
    height: '38px'
---

# Design System: Nade Viewer

## Overview

**Creative North Star: "The Tactical Instrument Panel"**

Nade Viewer is a dense, dark, local-first operational workspace rather than a
marketing surface. Its interface should feel precise, calm under pressure, and
grounded in Counter-Strike radar imagery. The visual hierarchy directs attention
from map context to a selected cluster and then to a usable grenade detail.

The system uses a cool near-black foundation, restrained tonal layers, compact
controls, and a single acid-lime primary signal. Orbitron is reserved for
identity and high-value tactical headings; the body face carries dense data and
localized copy. Brand expression belongs in small, precise details, not large
decorative effects.

**Key Characteristics:**

- High-density desktop operations with progressive disclosure.
- Radar canvas as the primary artifact, not decorative background.
- Acid-lime reserved for current state, primary action, and successful focus.
- Localized, readable feedback for long-running and destructive operations.

## Colors

The palette is a cool graphite system with one tactical lime signal and semantic
colors that communicate grenade and operation state.

### Primary

- **Tactical lime** (`#c8f43d`): primary actions, active navigation, focus,
  Core state, and selected operational controls. Use sparingly.

### Secondary

- **Signal orange** (`#ff7447`): secondary emphasis and selected counts.
- **Map blue** (`#65a7ff`): CT and information accents where map semantics
  require it.
- **Alert red** (`#ff5e68`): destructive actions and errors only.

### Neutral

- **Radar black** (`#0a0c0f`): application background.
- **Panel graphite** (`#111419`, `#171b21`, `#1d222a`): layered workspace
  surfaces.
- **Structural line** (`#272c34`): boundaries and quiet grouping.
- **Signal text** (`#f4f6f8`, `#89929f`, `#5f6875`): ordered text hierarchy.

**The One Signal Rule.** Lime communicates action and current state. It must
not become a general-purpose decorative color.

## Typography

**Display Font:** Orbitron, sans-serif

**Body Font:** Inter, "Segoe UI", sans-serif

**Character:** Technical display type gives headings and tactical labels a
recognizable identity. The body face must prioritize numeric scanability,
Russian localization, and legibility in a dense desktop workspace.

### Hierarchy

- **Display:** Orbitron 600-800 for product identity, map headings, and major
  import headings.
- **Title:** 12-14px semibold for selected grenade and workspace titles.
- **Body:** 10-12px for operational copy; use 11px or larger for persistent
  inspector content.
- **Label:** 8-11px semibold or bold with moderate tracking for compact
  metadata and filters.

**The Readability Floor Rule.** Persistent controls and inspector text should
not use type smaller than 10px unless the value is supplemental and available
through a clearer adjacent label or tooltip.

## Layout

The application is a full-window desktop workspace. The top bar carries global
navigation and library context. The map selection page uses a fixed information
rail with a scrollable map grid. Map and grenade detail pages pair a dominant
canvas with a scrollable inspector, then collapse to stacked panels below the
desktop breakpoint.

Use CSS grid for durable two-panel workspaces. Preserve current desktop-first
breakpoints and explicitly test localized text at narrower desktop widths.
Spacing is compact inside inspectors and more generous around import and map
selection surfaces.

## Elevation & Depth

Depth is primarily tonal: adjacent graphite surfaces and thin cool-gray lines
separate workspace regions. Shadows are reserved for overlays, popovers,
dialogs, and floating map controls. Blur appears only where a transient layer
must separate from the active workspace.

## Shapes

Controls use 7-9px corners, panels use 10-14px corners, and dialogs use 14-18px
corners. Borders are thin and low-contrast at rest, then strengthen on hover,
focus, or active state. Pills are reserved for short type and state badges.

## Components

### Buttons

- **Shape:** compact rounded rectangles (9px) with 38px standard height.
- **Primary:** tactical lime fill with near-black text.
- **Hover / Focus:** raised surface or stronger border on hover; visible lime
  focus outline with an outer halo.
- **Secondary / icon:** graphite surfaces with quiet border and clear pressed,
  disabled, and active states.

### Chips

- **Style:** small rectangular type and semantic badges for grenade type,
  side, Core, and instant-throw status.
- **State:** semantic grenade colors identify type; lime identifies active
  product state.

### Cards / Containers

- **Corner Style:** 8-14px according to hierarchy.
- **Background:** tonal graphite, never white card stacks.
- **Border:** one subtle cool-gray line, strengthened on interaction.
- **Internal Padding:** 9-15px in dense lists and inspector sections.

### Inputs / Fields

- **Style:** dark fill with a quiet border and 9px corner radius.
- **Focus:** lime outline and halo; do not rely only on a color shift.
- **Error / Disabled:** errors use red semantic copy and border; disabled
  controls reduce opacity without losing label legibility.

### Navigation

- **Style:** compact top navigation with icon-plus-label desktop actions and a
  clearly distinct active state.
- **Library context:** active snapshot remains visible but truncates safely.

### Tactical Map

The map canvas is the signature component. Radar imagery, markers,
trajectories, spawn points, legend, zoom actions, and previews must preserve
layer order and strong pointer feedback. Peripheral controls stay compact so
the playable map area remains dominant.

## Do's and Don'ts

### Do:

- **Do** keep the map and its selected result as the visual center of map
  workflows.
- **Do** use lime as a scarce operational signal.
- **Do** preserve visible keyboard focus and reduced-motion alternatives.
- **Do** keep import, destructive, loading, empty, and error states explicit
  and localized.
- **Do** use tabular figures for counts and timing when their columns need to
  scan vertically.

### Don't:

- **Don't** introduce generic SaaS gradients, marketing cards, or large
  decorative illustration into operational screens.
- **Don't** add a second competing primary accent.
- **Don't** let small labels become the only way to understand a control.
- **Don't** trade map canvas area for persistent panels without a clear task
  benefit.
