import type { ReplayEvent, ReplayPlayer } from '../types/replay';

export type ReplayAssist = { type: 'damage' | 'flash'; player?: ReplayPlayer };

// Match the replay killfeed in every kill preview, including older replay data.
export function replayAssists(
  event: ReplayEvent,
  players: ReplayPlayer[],
  events: ReplayEvent[],
  tickrate: number,
): ReplayAssist[] {
  const id = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const assister = players.find(
    (player) => player.id === id(event.data?.assister_id),
  );
  const flashId = id(event.data?.flash_assister_id);
  const flashAssister = players.find((player) => player.id === flashId);
  let damageEvent: ReplayEvent | undefined;
  for (const candidate of events) {
    if (
      candidate.type === 'damage' &&
      candidate.target_id === event.target_id &&
      candidate.player_id &&
      candidate.player_id !== event.player_id &&
      candidate.player_id !== flashId &&
      candidate.tick <= event.tick &&
      candidate.tick >= event.tick - tickrate * 5 &&
      (!damageEvent || candidate.tick > damageEvent.tick)
    )
      damageEvent = candidate;
  }
  const damageAssister = damageEvent
    ? players.find((player) => player.id === damageEvent.player_id)
    : undefined;
  const assists: ReplayAssist[] = [];
  if (assister && assister.id !== flashId)
    assists.push({ type: 'damage', player: assister });
  if (
    damageAssister &&
    damageAssister.id !== assister?.id &&
    damageAssister.id !== flashId
  )
    assists.push({ type: 'damage', player: damageAssister });
  if (event.data?.assisted_flash === true)
    assists.push({ type: 'flash', player: flashAssister });
  return assists;
}
