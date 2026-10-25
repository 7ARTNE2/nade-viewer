import type { ReplayFrame, ReplayPlayer, ReplayRound } from '../types/replay';

export const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));
export function framePair(
  round: ReplayRound,
  tick: number,
): [ReplayFrame | undefined, ReplayFrame | undefined, number] {
  const frames = round.frames;
  let lo = 0,
    hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  const a = frames[Math.max(0, lo - 1)],
    b = frames[Math.min(frames.length - 1, lo)];
  return [
    a,
    b,
    a && b && b.tick > a.tick
      ? clamp((tick - a.tick) / (b.tick - a.tick), 0, 1)
      : 0,
  ];
}
export function playersAt(round: ReplayRound, tick: number): ReplayPlayer[] {
  const [frame] = framePair(round, tick);
  if (!frame) return [];
  const killed = new Set(
    round.events
      .filter((e) => e.type === 'kill' && e.tick > frame.tick && e.tick <= tick)
      .map((e) => e.target_id),
  );
  return frame.players.map((player) =>
    killed.has(player.id) ? { ...player, alive: false, health: 0 } : player,
  );
}

export function interpolatePlayer(
  a: ReplayPlayer,
  b: ReplayPlayer | undefined,
  t: number,
): ReplayPlayer {
  if (!b || a.alive !== b.alive || Math.hypot(a.x - b.x, a.y - b.y) > 300)
    return a;
  const delta = ((b.yaw - a.yaw + 540) % 360) - 180;
  return {
    ...a,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    yaw: a.yaw + delta * t,
  };
}
export function roundBounds(round: ReplayRound): [number, number] {
  const start = round.frames[0]?.tick ?? round.round.start_tick;
  const end =
    round.frames[round.frames.length - 1]?.tick ??
    round.round.end_tick ??
    start;
  return [start, Math.max(start, end)];
}
export function timeLabel(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
export function activeSmokes(round: ReplayRound, tick: number) {
  const active = new Map<string, { x: number; y: number; z: number }>();
  for (const event of round.events) {
    if (event.tick > tick) break;
    const id = String(event.data?.grenade_entity_id ?? '');
    if (event.type === 'smoke_start' && event.x !== null && event.y !== null)
      active.set(id, { x: event.x, y: event.y, z: event.z ?? 0 });
    if (event.type === 'smoke_expired') active.delete(id);
  }
  return [...active.values()];
}
