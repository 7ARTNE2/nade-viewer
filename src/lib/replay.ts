import { invoke } from '@tauri-apps/api/core';
import type { ReplayDetail, ReplayEntry, ReplayRound } from '../types/replay';

export const listReplays = () => invoke<ReplayEntry[]>('list_replays');
export const getReplay = (id: number) =>
  invoke<ReplayDetail>('get_replay', { id });
export const getReplayRound = (id: number, number: number) =>
  invoke<ReplayRound>('get_replay_round', { id, number });
export const startReplay = (path: string) =>
  invoke<void>('start_replay', { path });
export const deleteReplay = (id: number) =>
  invoke<void>('delete_replay', { id });
export const getReplayCapability = () =>
  invoke<boolean>('get_replay_capability');
export const saveReplayPosition = (id: number, number: number, tick: number) =>
  invoke<void>('save_replay_position', { id, number, tick });
