import type { MapSummary } from './domain';

export type ReplayPlayer = {
  id: string;
  steamid64: string;
  name: string;
  side: string;
  team_name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  alive: boolean;
  health: number;
  armor: number;
  money: number;
  active_weapon: string;
  has_helmet: boolean;
  has_defuse_kit: boolean;
  flashed: boolean;
  kills: number;
  assists: number;
  deaths: number;
};
export type ReplayProjectile = {
  id: string;
  type: string;
  thrower_id: string;
  x: number;
  y: number;
  z: number;
};
export type ReplayFrame = {
  tick: number;
  round_number: number;
  players: ReplayPlayer[];
  projectiles: ReplayProjectile[];
  infernos: {
    id: string;
    fires: { x: number; y: number; z: number; burning: boolean }[];
    hull: { x: number; y: number }[];
  }[];
  bomb: {
    x: number;
    y: number;
    z: number;
    state: string;
    site: string;
    carrier_id: string;
  } | null;
};
export type ReplayEvent = {
  tick: number;
  round_number: number;
  type: string;
  message: string;
  player_id?: string;
  target_id?: string;
  x: number | null;
  y: number | null;
  z: number | null;
  data?: Record<string, unknown>;
};
export type ReplayGrenade = {
  id: string;
  round_number: number;
  release_tick: number;
  data: {
    grenade_type: string;
    thrower: string;
    thrower_steamid64?: string;
    thrower_team?: string;
    round_time_seconds?: number | null;
    side: string;
    throw_tick: number;
    throw_keys?: string;
    coordinates?: string;
    airtime?: number;
    trajectory?: number[][];
    start_pos_x?: number;
    start_pos_y?: number;
    start_pos_z?: number;
    explode_pos_x?: number;
    explode_pos_y?: number;
    explode_pos_z?: number;
  };
};
export type ReplayRoundSummary = {
  number: number;
  start_tick: number;
  freeze_end_tick: number | null;
  end_tick: number | null;
  winner_side: string;
  reason: string;
  score_t: number;
  score_ct: number;
};
export type ReplayRound = {
  round: ReplayRoundSummary;
  round_number: number;
  frames: ReplayFrame[];
  events: ReplayEvent[];
  grenades: ReplayGrenade[];
};
export type ReplayMetadata = {
  map: string;
  demo_filename: string;
  tickrate: number;
  sample_fps: number;
  start_tick: number;
  end_tick: number;
  team_t: string;
  team_ct: string;
  parsed_at: string;
  frame_count: number;
  round_count: number;
  incomplete?: boolean;
};
export type ReplayEntry = {
  id: number;
  metadata: ReplayMetadata;
  size: number;
  round_number: number;
  tick: number | null;
};
export type ReplayDetail = {
  id: number;
  metadata: ReplayMetadata;
  rounds: ReplayRoundSummary[];
  map: MapSummary;
  radar: {
    pos_x: number;
    pos_y: number;
    scale: number;
    split_z: number | null;
  } | null;
  round_number: number;
  tick: number | null;
};
