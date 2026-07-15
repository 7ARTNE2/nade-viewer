// Single source of truth for whether the viewer window is active and visible.
//
// When the window loses focus (e.g. the user tabs into CS2 running on top of
// it) WebView2 keeps rendering CSS animations and our playback loop at full
// speed, stealing GPU/CPU from the game. We track activity here so the rest of
// the app can pause animations and the replay render loop while inactive.
//
// Sources, combined with AND-ish logic:
//  - Tauri window focus (most accurate for a borderless game on top).
//  - DOM `visibilitychange` (covers minimize / occluded cases).
//  - window blur/focus (fallback when the Tauri API is unavailable).

type Listener = (active: boolean) => void;

let active = true;
const listeners = new Set<Listener>();
let started = false;

function computeAndEmit(next: boolean) {
  if (next === active) return;
  active = next;
  document.body.classList.toggle("app-inactive", !active);
  for (const listener of listeners) listener(active);
}

export function isWindowActive(): boolean {
  return active;
}

export function onWindowActiveChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Track the two DOM signals plus the Tauri focus signal separately, then derive
// the combined "active" state so any single "inactive" source wins.
let domVisible = typeof document === "undefined" ? true : !document.hidden;
let windowFocused = true;
let tauriFocused = true;

function recompute() {
  computeAndEmit(domVisible && windowFocused && tauriFocused);
}

export function startWindowActiveTracking(): () => void {
  if (started) return () => undefined;
  started = true;

  const onVisibility = () => {
    domVisible = !document.hidden;
    recompute();
  };
  const onFocus = () => {
    windowFocused = true;
    recompute();
  };
  const onBlur = () => {
    windowFocused = false;
    recompute();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);

  // Initialize from current state.
  domVisible = !document.hidden;
  windowFocused = document.hasFocus();
  recompute();

  // Tauri focus is the most reliable signal for a fullscreen/borderless game
  // sitting on top of our window. Wire it up lazily so the app still works in a
  // plain browser dev context.
  let unlistenTauri: (() => void) | null = null;
  let disposed = false;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      if (disposed) return;
      const win = getCurrentWindow();
      return win.onFocusChanged(({ payload: focused }) => {
        tauriFocused = focused;
        recompute();
      });
    })
    .then((unlisten) => {
      if (typeof unlisten === "function") {
        if (disposed) unlisten();
        else unlistenTauri = unlisten;
      }
    })
    .catch(() => {
      // Not running under Tauri (e.g. browser dev server) — DOM signals suffice.
    });

  return () => {
    disposed = true;
    started = false;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    unlistenTauri?.();
  };
}
