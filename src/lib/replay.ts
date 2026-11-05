import { invoke } from '@tauri-apps/api/core';
import type { ReplayDetail, ReplayEntry, ReplayRound } from '../types/replay';

async function replayCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const report = `[Replay diagnostics]\ntime: ${new Date().toISOString()}\ncommand: ${command}\narguments: ${JSON.stringify(args ?? {})}\n${String(error)}`;
    console.error(report);
    throw report;
  }
}

export const listReplays = () => replayCommand<ReplayEntry[]>('list_replays');
export const getReplay = (id: number) =>
  replayCommand<ReplayDetail | null>('get_replay', { id });
export const getReplayRound = (id: number, number: number) =>
  replayCommand<ReplayRound>('get_replay_round', { id, number });
export const getReplayRoundPreview = (id: number, number: number) =>
  replayCommand<ReplayRound>('get_replay_round_preview', { id, number });
export const startReplay = (path: string, profile: 'v5' | 'v6' = 'v5') =>
  replayCommand<void>('start_replay', { path, profile });
export const deleteReplay = (id: number) =>
  replayCommand<void>('delete_replay', { id });
export const getReplayCapability = () =>
  replayCommand<boolean>('get_replay_capability');
export const saveReplayPosition = (id: number, number: number, tick: number) =>
  replayCommand<void>('save_replay_position', { id, number, tick });
