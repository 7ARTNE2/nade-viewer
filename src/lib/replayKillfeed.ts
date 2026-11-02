import type { ReplayEvent } from '../types/replay';

export const KILLFEED_SECONDS = 6;
export const KILLFEED_FADE_SECONDS = 0.3;
export const KILLFEED_MAX_ROWS = 5;

export function killNotices(event: ReplayEvent) {
  const data = event.data ?? {};
  const result: string[] = [];
  if (data.headshot === true) result.push('headshot');
  if (data.attacker_blind === true) result.push('blind');
  if (data.wallbang === true || Number(data.penetrated_objects ?? 0) > 0)
    result.push('penetrate');
  if (data.through_smoke === true) result.push('smoke');
  if (event.player_id && event.player_id === event.target_id)
    result.push('suicide');
  return result;
}

export function killfeedOpacity(
  eventTick: number,
  tick: number,
  tickrate: number,
) {
  const age = (tick - eventTick) / tickrate;
  if (age < 0 || age >= KILLFEED_SECONDS) return 0;
  return Math.min(1, (KILLFEED_SECONDS - age) / KILLFEED_FADE_SECONDS);
}
