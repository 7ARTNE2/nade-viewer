import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import {
  clamp,
  roundBounds,
  roundPhaseTime,
  replayTimers,
  timeLabel,
} from '../lib/replayPlayback';
import type { ReplayEvent, ReplayRound } from '../types/replay';
import GrenadeMapIcon from './GrenadeMapIcon';
import type { ReplayGrenade } from '../types/replay';
import flashbangAssistIcon from '../assets/equipment_icons/flashbang_assist.svg';
import { deathNoticeIcon } from '../lib/deathNoticeIcons';
import { weaponIcon } from '../lib/weaponIcons';
import { playersAt } from '../lib/replayPlayback';

type Props = {
  round: ReplayRound;
  clock: { current: number };
  tick: number;
  tickrate: number;
  playing: boolean;
  events: ReplayEvent[];
  grenades: ReplayGrenade[];
  grenadeTick: (grenade: ReplayGrenade) => number;
  onGrenadeSelect: (grenade: ReplayGrenade) => void;
  onSeek: (tick: number) => void;
  showFreezeTime: boolean;
};

export default function ReplayTimeline({
  round,
  clock,
  tick,
  tickrate,
  playing,
  events,
  grenades,
  grenadeTick,
  onGrenadeSelect,
  onSeek,
  showFreezeTime,
}: Props) {
  const { tr } = useI18n();
  const [hoveredKill, setHoveredKill] = useState<number | null>(null);
  const slider = useRef<HTMLInputElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const elapsed = useRef<HTMLTimeElement>(null);
  const [start, end] = roundBounds(round);
  const actionStart = round.round.freeze_end_tick ?? round.round.start_tick;
  const freezeLabel = tr('Freeze time', 'Фризтайм');
  const roundLabel = tr('Round', 'Раунд');
  const bombLabel = tr('Bomb', 'Бомба');
  const defusedLabel = tr('Defused', 'Обезврежена');
  const explodedLabel = tr('Exploded', 'Взорвалась');
  // When freeze time is hidden, compress it out of the visible timeline.
  const timelineStart = showFreezeTime ? start : actionStart;
  const progress = (value: number) =>
    clamp(((value - timelineStart) / (end - timelineStart || 1)) * 100, 0, 100);
  const current = clamp(clock.current, timelineStart, end);
  const killTicks = useMemo(() => {
    const ticks = new Map<string, number>();
    for (const event of round.events) {
      if (event.type !== 'kill' || !event.target_id) continue;
      const previous = ticks.get(event.target_id);
      if (previous === undefined || event.tick < previous) ticks.set(event.target_id, event.tick);
    }
    return ticks;
  }, [round]);
  const killEvents = events.filter((event) => event.type === 'kill');
  const plant = round.events.find((event) => event.type === 'bomb_planted');
  const resolution = round.events.find(
    (event) =>
      plant &&
      event.tick >= plant.tick &&
      ['bomb_defused', 'bomb_exploded'].includes(event.type),
  );
  const bombEnd = plant
    ? (resolution?.tick ??
      (typeof plant.data?.duration_seconds === 'number'
        ? plant.tick + plant.data.duration_seconds * tickrate
        : end))
    : end;
  const phaseSegments: Array<[number, number, string]> = [];
  const addPhase = (from: number, to: number, color: string) => {
    const left = Math.max(from, timelineStart);
    const right = Math.min(to, end);
    if (right > left) phaseSegments.push([left, right, color]);
  };
  if (showFreezeTime) addPhase(start, actionStart, '#8fd8ff');
  const roundStart = Math.max(timelineStart, actionStart);
  addPhase(roundStart, plant?.tick ?? end, '#c7ff3d');
  if (plant) {
    addPhase(plant.tick, bombEnd, '#ff8e96');
    addPhase(bombEnd, end, '#c7ff3d');
  }
  const visibleSegments = phaseSegments.flatMap(([from, to, color]) => {
    const visibleTo = Math.min(to, current);
    if (visibleTo <= from) return [];
    return [
      {
        left: progress(from),
        width: progress(visibleTo) - progress(from),
        color,
      },
    ];
  });
  const labelAt = useCallback(
    (value: number) => {
      const bomb = replayTimers(round, value, tickrate).bomb;
      if (bomb) {
        if (bomb.state === 'bomb_defused') return defusedLabel;
        if (bomb.state === 'bomb_exploded') return explodedLabel;
        return `${bombLabel} ${bomb.time}`;
      }
      const phase = roundPhaseTime(round.round, value, tickrate);
      return `${phase.freezing ? freezeLabel : roundLabel} ${phase.label}`;
    },
    [
      round,
      tickrate,
      freezeLabel,
      roundLabel,
      bombLabel,
      defusedLabel,
      explodedLabel,
    ],
  );
  const sync = useCallback(() => {
    const value = clamp(clock.current, timelineStart, end);
    const timers = replayTimers(round, value, tickrate);
    const phaseColor = timers.bomb
      ? '#ff8e96'
      : timers.freezing
        ? '#8fd8ff'
        : '#c7ff3d';
    if (slider.current) {
      slider.current.value = String(value);
      slider.current.style.accentColor = phaseColor;
    }
    if (track.current) track.current.style.background = 'var(--surface-3)';
    if (elapsed.current) {
      elapsed.current.textContent = labelAt(value);
    }
  }, [clock, timelineStart, end, labelAt, round, tickrate]);
  // Keep the scrubber on the playback clock without rendering the match each frame.
  useEffect(() => {
    let animation = 0;
    const draw = () => {
      sync();
      if (playing) animation = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animation);
  }, [playing, sync]);
  useLayoutEffect(() => {
    sync();
  }, [tick, sync]);
  return (
    <div className="replay-timeline">
      <div>
        <time ref={elapsed} className="replay-phase-time">
          {labelAt(current)}
        </time>
        <time>
          {timeLabel((end - Math.max(start, actionStart)) / tickrate)}
        </time>
      </div>
      <div className="replay-timeline-grenade-rail" aria-label={tr('Grenades', 'Гранаты')}>
        {grenades
          .filter((grenade) => showFreezeTime || grenadeTick(grenade) >= actionStart)
          .map((grenade) => {
            const grenadeType = grenade.data.grenade_type.toLowerCase().replace(/ /g, '-');
            const markerTick = grenadeTick(grenade);
            return (
              <span
                className={`replay-timeline-grenade-marker type-${grenadeType}`}
                key={grenade.id}
                style={{ left: `${progress(markerTick)}%` }}
                title={`${grenade.data.thrower} · ${grenade.data.grenade_type} · ${labelAt(markerTick)}`}
              >
                <button
                  type="button"
                  aria-label={`${grenade.data.thrower} · ${grenade.data.grenade_type}`}
                  onClick={() => onGrenadeSelect(grenade)}
                >
                  <GrenadeMapIcon grenadeType={grenade.data.grenade_type} />
                </button>
              </span>
            );
          })}
      </div>
      <input
        ref={slider}
        type="range"
        min={timelineStart}
        max={Math.max(timelineStart + 1, end)}
        step="any"
        defaultValue={current}
        aria-label={tr('Replay timeline', 'Таймлайн повтора')}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <div
        ref={track}
        className="replay-timeline-track"
        style={{
          background: 'var(--surface-3)',
        }}
      >
        {phaseSegments.map(([from, to, color], index) => (
          <span
            key={`marker-${index}`}
            className="replay-phase-segment"
            style={{
              left: `${progress(from)}%`,
              width: `${progress(to) - progress(from)}%`,
              background: color,
            }}
          />
        ))}
        {visibleSegments.map(({ left, width, color }, index) => (
          <span
            key={index}
            className="replay-progress-segment"
            style={{ left: `${left}%`, width: `${width}%`, background: color }}
          />
        ))}
      </div>
      <div className="replay-event-ticks">
        {events
          .filter((event) => showFreezeTime || event.tick >= actionStart)
          .map((event, index) => {
            const killIndex = event.type === 'kill' ? killEvents.indexOf(event) : -1;
            if (killIndex < 0) {
              return <i key={index} style={{ left: `${progress(event.tick)}%` }} />;
            }
            const eventPlayers = playersAt(round, event.tick, round.events, killTicks);
            const killer = eventPlayers.find((player) => player.id === event.player_id);
            const victim = eventPlayers.find((player) => player.id === event.target_id);
            const assisterId = String(event.data?.assister_id ?? '');
            const flashAssisterId = String(event.data?.flash_assister_id ?? '');
            const assister = eventPlayers.find((player) => player.id === assisterId);
            const flashAssister = eventPlayers.find((player) => player.id === flashAssisterId);
            const weapon = String(event.data?.weapon ?? '');
            const notices = [
              event.data?.headshot === true ? 'headshot' : '',
              event.data?.attacker_blind === true ? 'blind' : '',
              event.data?.wallbang === true || Number(event.data?.penetrated_objects ?? 0) > 0 ? 'penetrate' : '',
              event.data?.through_smoke === true ? 'smoke' : '',
              event.player_id && event.player_id === event.target_id ? 'suicide' : '',
            ].filter(Boolean).map((id) => ({ id, icon: deathNoticeIcon(id) })).filter((item) => item.icon);
            const isHovered = hoveredKill === killIndex;
            const edge = progress(event.tick) < 18 ? 'is-start' : progress(event.tick) > 82 ? 'is-end' : '';
            return (
              <span
                className="replay-timeline-event-marker"
                key={index}
                style={{ left: `${progress(event.tick)}%` }}
                onMouseEnter={() => setHoveredKill(killIndex)}
                onMouseLeave={() => setHoveredKill(null)}
                onFocus={() => setHoveredKill(killIndex)}
                onBlur={() => setHoveredKill(null)}
              >
                <button
                  type="button"
                  aria-label={`${killer?.name ?? event.player_id ?? 'World'} → ${victim?.name ?? event.target_id ?? '—'}`}
                  onClick={() => onSeek(event.tick)}
                />
                {isHovered && (
                  <span className={`replay-timeline-kill-preview ${edge}`} role="tooltip">
                    <time>{labelAt(event.tick)}</time>
                    <span className="replay-timeline-kill-main">
                      <b className={`replay-killfeed-name ${String(killer?.side ?? 'world').toLowerCase()}`}>{killer?.name ?? event.player_id ?? 'World'}</b>
                      {event.data?.assisted_flash === true && flashAssister && <span className="replay-timeline-kill-assist flash"><img src={flashbangAssistIcon} alt="" />+{flashAssister.name}</span>}
                      {assister && <span className="replay-timeline-kill-assist">+{assister.name}</span>}
                      {weapon && <img className="replay-timeline-kill-weapon" src={weaponIcon(weapon)} alt="" />}
                      {notices.map((notice) => <img className="replay-timeline-kill-notice" key={notice.id} src={notice.icon} alt="" />)}
                      <b className={`replay-killfeed-name ${String(victim?.side ?? 'world').toLowerCase()}`}>{victim?.name ?? event.target_id ?? '—'}</b>
                    </span>
                  </span>
                )}
              </span>
            );
          })}
      </div>
    </div>
  );
}
