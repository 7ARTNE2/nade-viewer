import { useCallback, useSyncExternalStore } from 'react';
import type {
  ReplayDetail,
  ReplayEntry,
  ReplayRoundSummary,
} from '../types/replay';

export type ReplayStroke = {
  tool: 'pen' | 'arrow' | 'circle';
  color: string;
  points: [number, number][];
};
export type ReplayNote = {
  id: string;
  round: number;
  tick: number;
  lower: boolean;
  text: string;
  strokes: ReplayStroke[];
};
type Source = Pick<ReplayEntry, 'id' | 'metadata'>;
const empty: ReplayNote[] = [];
const cache = new Map<string, { raw: string | null; notes: ReplayNote[] }>();
const changed = 'nadeviewer:replay-notes-changed';

export function replayNotesKey(source: Source) {
  return `nadeviewer.replay-notes.v1.${source.id}.${source.metadata.parsed_at}`;
}

export function loadReplayNotes(key: string): ReplayNote[] {
  try {
    const raw = localStorage.getItem(key);
    const cached = cache.get(key);
    if (cached?.raw === raw) return cached.notes;
    const data: unknown = JSON.parse(raw ?? '[]');
    const notes = Array.isArray(data)
      ? data.filter(
          (note): note is ReplayNote =>
            note &&
            typeof note.id === 'string' &&
            Number.isFinite(note.round) &&
            Number.isFinite(note.tick) &&
            typeof note.lower === 'boolean' &&
            typeof note.text === 'string' &&
            Array.isArray(note.strokes) &&
            note.strokes.every(
              (stroke: ReplayStroke) =>
                stroke &&
                ['pen', 'arrow', 'circle'].includes(stroke.tool) &&
                typeof stroke.color === 'string' &&
                /^#[0-9a-f]{6}$/i.test(stroke.color) &&
                Array.isArray(stroke.points) &&
                stroke.points.length > 0 &&
                stroke.points.every(
                  (point) =>
                    Array.isArray(point) &&
                    point.length === 2 &&
                    point.every(Number.isFinite),
                ),
            ),
        )
      : empty;
    cache.set(key, { raw, notes });
    return notes;
  } catch {
    return empty;
  }
}

export function saveReplayNotes(key: string, notes: ReplayNote[]) {
  const raw = JSON.stringify(notes);
  if (localStorage.getItem(key) === raw) return;
  localStorage.setItem(key, raw);
  window.dispatchEvent(new Event(changed));
}

export function deleteReplayNotes(source: Source) {
  const key = replayNotesKey(source);
  localStorage.removeItem(key);
  cache.delete(key);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener('storage', listener);
  };
}

export function useReplayNotes(source: Source | ReplayDetail | null) {
  const key = source ? replayNotesKey(source) : null;
  const snapshot = useCallback(
    () => (key ? loadReplayNotes(key) : empty),
    [key],
  );
  return useSyncExternalStore(subscribe, snapshot);
}

export function replayNoteTime(
  note: ReplayNote,
  tickrate: number,
  round?: ReplayRoundSummary,
) {
  if (!round) return '—';
  const origin = round.freeze_end_tick ?? round.start_tick;
  const freezing = note.tick < origin;
  const seconds = Math.max(
    0,
    freezing
      ? Math.ceil((origin - note.tick) / tickrate)
      : Math.floor((note.tick - origin) / tickrate),
  );
  return `${freezing ? '❄ ' : ''}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
