import type {
  ReplayEvent,
  ReplayFrame,
  ReplayPlayer,
  ReplayRound,
  ReplayRoundSummary,
} from '../types/replay';

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
export function playersAt(
  round: ReplayRound,
  tick: number,
  killEvents = round.events,
  killTicks?: ReadonlyMap<string, number>,
  currentFrame?: ReplayFrame,
): ReplayPlayer[] {
  const frame = currentFrame ?? framePair(round, tick)[0];
  if (!frame) return [];
  const killed = killTicks
    ? null
    : new Set(
        killEvents
          .filter(
            (e) => e.type === 'kill' && e.tick > frame.tick && e.tick <= tick,
          )
          .map((e) => e.target_id),
      );
  return frame.players.map((player) =>
    (
      killTicks
        ? (killTicks.get(player.id) ?? Infinity) > frame.tick &&
          (killTicks.get(player.id) ?? Infinity) <= tick
        : killed!.has(player.id)
    )
      ? { ...player, alive: false, health: 0 }
      : player,
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
export function playerBombAction(
  player: ReplayPlayer,
  tick: number,
  tickrate: number,
  events: readonly ReplayEvent[],
) {
  if (!player.alive || tickrate <= 0 || (!player.planting && !player.defusing))
    return null;
  const defusing = Boolean(player.defusing);
  const startType = defusing ? 'bomb_defuse_start' : 'bomb_plant_begin';
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  const start = events[lo - 1];
  // Sampled flags can persist across rounds. Only a start event in this
  // round can establish an action; completion events invalidate it immediately.
  if (start?.type !== startType) return null;
  const duration = defusing ? (player.has_defuse_kit ? 5 : 10) : 3.2;
  const elapsed = (tick - start.tick) / tickrate;
  if (elapsed < 0 || elapsed >= duration) return null;
  return {
    label: defusing ? 'DEFUSE' : 'PLANT',
    defusing,
    progress: elapsed / duration,
    remaining: duration - elapsed,
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
export function roundPhaseTime(
  round: ReplayRoundSummary,
  tick: number,
  tickrate: number,
) {
  const start = round.freeze_end_tick ?? round.start_tick;
  const freezing = round.freeze_end_tick !== null && tick < start;
  const seconds = freezing
    ? Math.ceil((start - tick) / tickrate)
    : (tick - start) / tickrate;
  return { freezing, label: timeLabel(seconds) };
}
export function replayTimers(
  round: ReplayRound,
  tick: number,
  tickrate: number,
) {
  const start = round.round.freeze_end_tick ?? round.round.start_tick;
  const freeze = roundPhaseTime(round.round, tick, tickrate);
  const planted = round.events.find((event) => event.type === 'bomb_planted');
  const resolved = round.events.find((event) =>
    ['bomb_defused', 'bomb_exploded'].includes(event.type),
  );
  const duration = round.round.duration_seconds;
  const stopped = Math.min(
    tick,
    planted?.tick ?? Infinity,
    round.round.end_tick ?? Infinity,
  );
  const remaining =
    typeof duration === 'number' && duration > 0
      ? timeLabel(Math.ceil(duration - Math.max(0, stopped - start) / tickrate))
      : '-';
  const bombDuration = planted?.data?.duration_seconds;
  return {
    freezing: freeze.freezing,
    round: freeze.freezing ? freeze.label : remaining,
    bomb:
      planted && tick >= planted.tick
        ? {
            site: planted.message,
            state:
              resolved && tick >= resolved.tick ? resolved.type : 'planted',
            time:
              typeof bombDuration === 'number' && bombDuration > 0
                ? timeLabel(
                    Math.ceil(
                      bombDuration -
                        (Math.min(tick, resolved?.tick ?? Infinity) -
                          planted.tick) /
                          tickrate,
                    ),
                  )
                : '-',
          }
        : null,
  };
}
export type SmokeTimeline = {
  events: ReplayRound['events'];
  expirations: Map<string, number[]>;
};

export function buildSmokeTimeline(round: ReplayRound): SmokeTimeline {
  const expirations = new Map<string, number[]>();
  const events = round.events.filter(
    (event) => event.type === 'smoke_start' || event.type === 'smoke_expired',
  );
  events.forEach((event) => {
    if (event.type !== 'smoke_expired') return;
    const id = String(event.data?.grenade_entity_id ?? '');
    expirations.set(id, [...(expirations.get(id) ?? []), event.tick]);
  });
  return { events, expirations };
}

export function activeSmokes(
  round: ReplayRound,
  tick: number,
  tickrate = 64,
  timeline = buildSmokeTimeline(round),
) {
  const { events, expirations } = timeline;
  const [, roundEndTick] = roundBounds(round);
  const active = new Map<
    string,
    {
      x: number;
      y: number;
      z: number;
      side?: string;
      startTick: number;
      expireTick: number;
    }
  >();
  for (const event of events) {
    if (event.tick > tick) break;
    const id = String(event.data?.grenade_entity_id ?? '');
    if (event.type === 'smoke_start' && event.x !== null && event.y !== null) {
      // Use the demo's expiration, or the end of the recorded round when absent.
      const expireTick =
        expirations.get(id)?.find((value) => value > event.tick) ??
        roundEndTick;
      if (tick < expireTick) {
        active.set(id, {
          x: event.x,
          y: event.y,
          z: event.z ?? 0,
          side: event.side,
          startTick: event.tick,
          expireTick,
        });
      }
    }
    if (event.type === 'smoke_expired') active.delete(id);
  }
  return [...active.values()].map((smoke) => ({
    x: smoke.x,
    y: smoke.y,
    z: smoke.z,
    side: smoke.side,
    remainingSeconds: Math.max(0, smoke.expireTick - tick) / tickrate,
    progress: clamp(
      (tick - smoke.startTick) /
        Math.max(1, smoke.expireTick - smoke.startTick),
      0,
      1,
    ),
  }));
}
