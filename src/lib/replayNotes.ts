import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReplayEntry, ReplayRoundSummary } from '../types/replay';

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
export type StoredReplayNote = {
  replay_id: number;
  note: ReplayNote;
  round_summary: ReplayRoundSummary | null;
  updated_at: number;
};
type Source = Pick<ReplayEntry, 'id'>;
type NotesState = {
  items: StoredReplayNote[];
  loading: boolean;
  loadError: string;
  saveErrors: Record<number, string>;
  saving: number[];
};
let state: NotesState = {
  items: [],
  loading: true,
  loadError: '',
  saveErrors: {},
  saving: [],
};
let loaded = false;
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();
const pending = new Map<number, ReplayNote[]>();
const active = new Set<number>();
const generations = new Map<number, number>();
function publish(update: Partial<NotesState>) {
  state = { ...state, ...update };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => state;

async function ensureNotes() {
  if (loaded) return;
  if (!request) {
    publish({ loading: true, loadError: '' });
    request = invoke<StoredReplayNote[]>('list_replay_notes')
      .then((items) => {
        loaded = true;
        publish({ items, loading: false });
      })
      .catch((error: unknown) => {
        publish({ loading: false, loadError: String(error) });
        throw error;
      })
      .finally(() => {
        request = null;
      });
  }
  return request;
}

export async function loadReplayNotes(replayId: number): Promise<ReplayNote[]> {
  await ensureNotes();
  return state.items
    .filter((item) => item.replay_id === replayId)
    .map((item) => item.note);
}

// One writer per replay prevents a slow earlier save overwriting a newer edit.
async function flush(replayId: number) {
  if (active.has(replayId)) return;
  active.add(replayId);
  const generation = generations.get(replayId);
  publish({ saving: [...active] });
  try {
    while (pending.has(replayId)) {
      const notes = pending.get(replayId)!;
      pending.delete(replayId);
      try {
        const items = await invoke<StoredReplayNote[]>('save_replay_notes', {
          replayId,
          notes,
        });
        if (generations.get(replayId) !== generation) return;
        const saveErrors = { ...state.saveErrors };
        delete saveErrors[replayId];
        publish({
          ...(pending.has(replayId)
            ? {}
            : {
                items: [
                  ...state.items.filter((item) => item.replay_id !== replayId),
                  ...items,
                ],
              }),
          saveErrors,
        });
      } catch (error) {
        if (generations.get(replayId) !== generation) return;
        if (!pending.has(replayId)) pending.set(replayId, notes);
        publish({
          saveErrors: { ...state.saveErrors, [replayId]: String(error) },
        });
        break;
      }
    }
  } finally {
    active.delete(replayId);
    publish({ saving: [...active] });
  }
}

export function saveReplayNotes(replayId: number, notes: ReplayNote[]) {
  if (!loaded) return;
  const previous = new Map(
    state.items
      .filter((item) => item.replay_id === replayId)
      .map((item) => [item.note.id, item]),
  );
  const items = notes.map((note): StoredReplayNote => {
    const old = previous.get(note.id);
    return {
      replay_id: replayId,
      note,
      round_summary: old?.round_summary ?? null,
      updated_at:
        old && JSON.stringify(old.note) === JSON.stringify(note)
          ? old.updated_at
          : Date.now(),
    };
  });
  pending.set(replayId, notes);
  publish({
    items: [
      ...state.items.filter((item) => item.replay_id !== replayId),
      ...items,
    ],
  });
  void flush(replayId);
}

// SQLite cascades deletion; discard the matching in-memory snapshot afterwards.
export function deleteReplayNotes(source: Source) {
  generations.set(source.id, (generations.get(source.id) ?? 0) + 1);
  pending.delete(source.id);
  const saveErrors = { ...state.saveErrors };
  delete saveErrors[source.id];
  publish({
    items: state.items.filter((item) => item.replay_id !== source.id),
    saveErrors,
  });
}

export function retryReplayNotes(replayId?: number) {
  if (!loaded) {
    void ensureNotes().catch(() => undefined);
    return;
  }
  for (const id of pending.keys())
    if (replayId === undefined || replayId === id) void flush(id);
}

export function useAllReplayNotes() {
  const value = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    void ensureNotes().catch(() => undefined);
  }, []);
  return value;
}

export function useReplayNotes(source: Source | null) {
  const { items } = useAllReplayNotes();
  return useMemo(
    () =>
      items
        .filter((item) => item.replay_id === source?.id)
        .map((item) => item.note),
    [items, source?.id],
  );
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
