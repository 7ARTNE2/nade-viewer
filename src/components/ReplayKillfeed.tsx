import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { playersAt } from '../lib/replayPlayback';
import { deathNoticeIcon } from '../lib/deathNoticeIcons';
import { weaponIcon } from '../lib/weaponIcons';
import { onReplayAnimationFrame } from '../lib/replayAnimation';
import {
  killfeedOpacity,
  killNotices,
  KILLFEED_MAX_ROWS,
} from '../lib/replayKillfeed';
import type { ReplayRound } from '../types/replay';
import ReplayKillAssists from './ReplayKillAssists';

type Props = {
  round: ReplayRound;
  clock: { current: number };
  tick: number;
  tickrate: number;
  playing: boolean;
};

export default function ReplayKillfeed({
  round,
  clock,
  tick,
  tickrate,
  playing,
}: Props) {
  const { tr } = useI18n();
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);
  const rows = useMemo(() => {
    const kills = round.events.filter((event) => event.type === 'kill');
    const damage = round.events.filter((event) => event.type === 'damage');
    const killTicks = new Map<string, number>();
    for (const event of kills) {
      if (event.target_id && !killTicks.has(event.target_id))
        killTicks.set(event.target_id, event.tick);
    }
    return kills.map((event, index) => {
      const players = playersAt(round, event.tick, kills, killTicks);
      return {
        event,
        key: `${event.tick}-${event.target_id}-${index}`,
        players,
        damage,
        killer: players.find((player) => player.id === event.player_id),
        victim: players.find((player) => player.id === event.target_id),
        weapon: String(event.data?.weapon ?? ''),
        notices: killNotices(event)
          .map((id) => ({ id, icon: deathNoticeIcon(id) }))
          .filter((item) => item.icon),
      };
    });
  }, [round]);
  const current = playing ? clock.current : tick;
  const visible = rows
    .filter(({ event }) => killfeedOpacity(event.tick, current, tickrate) > 0)
    .slice(-KILLFEED_MAX_ROWS);
  const lastVisibleKeys = useRef(visibleKeys);
  useLayoutEffect(() => {
    const update = () => {
      const current = playing ? clock.current : tick;
      const activeRows = rows
        .filter(
          ({ event }) => killfeedOpacity(event.tick, current, tickrate) > 0,
        )
        .slice(-KILLFEED_MAX_ROWS);
      const keys = activeRows.map((row) => row.key);
      if (
        keys.length !== lastVisibleKeys.current.length ||
        keys.some((key, index) => key !== lastVisibleKeys.current[index])
      ) {
        lastVisibleKeys.current = keys;
        setVisibleKeys(keys);
      }
      // Only membership needs a React render. The short fade follows demo
      // time directly, including speed changes, pauses and backward seeks.
      for (const { event, key } of activeRows) {
        const element = rowElements.current.get(key);
        const opacity = String(killfeedOpacity(event.tick, current, tickrate));
        if (element && element.style.opacity !== opacity)
          element.style.opacity = opacity;
      }
    };
    update();
    if (playing) return onReplayAnimationFrame(update);
  }, [playing, clock, rows, tick, tickrate]);

  return (
    <div className="replay-killfeed" aria-label={tr('Kill feed', 'Киллчат')}>
      {visible.map(
        ({ event, key, players, damage, killer, victim, weapon, notices }) => (
          <div
            className="replay-killfeed-row"
            key={key}
            ref={(element) => {
              if (element) rowElements.current.set(key, element);
              else rowElements.current.delete(key);
            }}
            data-tick={event.tick}
            style={{ opacity: killfeedOpacity(event.tick, current, tickrate) }}
          >
            <span
              className={`replay-killfeed-name ${String(killer?.side ?? 'world').toLowerCase()}`}
            >
              {killer?.name ?? event.player_id ?? 'World'}
            </span>
            <ReplayKillAssists
              event={event}
              players={players}
              events={damage}
              tickrate={tickrate}
              className="replay-killfeed-assist"
            />
            {weapon && (
              <img
                className="replay-killfeed-weapon"
                src={weaponIcon(weapon)}
                alt={weapon}
              />
            )}
            {notices.map((item) => (
              <img
                className="replay-killfeed-notice"
                key={item.id}
                src={item.icon}
                alt={item.id}
              />
            ))}
            <span
              className={`replay-killfeed-name ${String(victim?.side ?? 'world').toLowerCase()}`}
            >
              {victim?.name ?? event.target_id ?? '—'}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
