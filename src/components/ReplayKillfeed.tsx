import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { playersAt } from '../lib/replayPlayback';
import { deathNoticeIcon } from '../lib/deathNoticeIcons';
import { weaponIcon } from '../lib/weaponIcons';
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
  const [liveTick, setLiveTick] = useState(tick);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const update = () => {
      setLiveTick(clock.current);
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [playing, clock]);
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
  const current = playing ? liveTick : tick;
  const visible = rows
    .filter(({ event }) => killfeedOpacity(event.tick, current, tickrate) > 0)
    .slice(-KILLFEED_MAX_ROWS);

  return (
    <div className="replay-killfeed" aria-label={tr('Kill feed', 'Киллчат')}>
      {visible.map(
        ({ event, key, players, damage, killer, victim, weapon, notices }) => (
          <div
            className="replay-killfeed-row"
            key={key}
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
