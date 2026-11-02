import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw } from 'lucide-react';
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
  zoomPortalTarget: HTMLElement | null;
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
  zoomPortalTarget,
  onSeek,
  showFreezeTime,
}: Props) {
  const { tr } = useI18n();
  const [hoveredKill, setHoveredKill] = useState<number | null>(null);
  const [hoveredGrenade, setHoveredGrenade] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [dragging, setDragging] = useState(false);
  const slider = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; start: number } | null>(
    null,
  );
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
  const totalDuration = Math.max(1, end - timelineStart);
  const viewDuration = totalDuration / zoom;
  const maxViewStart = Math.max(timelineStart, end - viewDuration);
  const boundedViewStart = clamp(viewStart, timelineStart, maxViewStart);
  const viewEnd = boundedViewStart + viewDuration;
  const progress = (value: number) =>
    clamp(
      ((value - boundedViewStart) / (viewEnd - boundedViewStart || 1)) * 100,
      0,
      100,
    );
  const current = clamp(clock.current, timelineStart, end);
  const visibleCurrent = clamp(clock.current, boundedViewStart, viewEnd);
  const zoomAt = useCallback(
    (nextZoom: number, anchorRatio = 0.5) => {
      const next = clamp(nextZoom, 1, 8);
      const anchor = boundedViewStart + viewDuration * anchorRatio;
      const nextDuration = totalDuration / next;
      const nextMaxStart = Math.max(timelineStart, end - nextDuration);
      setZoom(next);
      setViewStart(
        clamp(anchor - nextDuration * anchorRatio, timelineStart, nextMaxStart),
      );
    },
    [boundedViewStart, end, timelineStart, totalDuration, viewDuration],
  );
  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (Math.abs(event.deltaY) < 1) return;
      event.preventDefault();
      const rect = viewport.current?.getBoundingClientRect();
      const ratio = rect
        ? clamp((event.clientX - rect.left) / rect.width, 0, 1)
        : 0.5;
      zoomAt(zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), ratio);
    },
    [zoom, zoomAt],
  );
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (zoom <= 1 || (event.target as HTMLElement).closest('button,input'))
        return;
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        start: boundedViewStart,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [boundedViewStart, zoom],
  );
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current || !viewport.current) return;
      const rect = viewport.current.getBoundingClientRect();
      const delta =
        ((event.clientX - drag.current.x) / Math.max(1, rect.width)) *
        viewDuration;
      setViewStart(
        clamp(drag.current.start - delta, timelineStart, maxViewStart),
      );
    },
    [maxViewStart, timelineStart, viewDuration],
  );
  const stopDragging = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      if (event.currentTarget.hasPointerCapture(drag.current.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.current.pointerId);
      }
      drag.current = null;
      setDragging(false);
    },
    [],
  );
  useEffect(() => {
    setZoom(1);
    setViewStart(timelineStart);
  }, [end, timelineStart]);
  useEffect(() => {
    setViewStart((value) => clamp(value, timelineStart, maxViewStart));
  }, [maxViewStart, timelineStart]);
  useEffect(() => {
    if (!playing || zoom <= 1) return;
    const margin = viewDuration * 0.18;
    if (
      clock.current < boundedViewStart + margin ||
      clock.current > viewEnd - margin
    ) {
      setViewStart(
        clamp(clock.current - viewDuration * 0.5, timelineStart, maxViewStart),
      );
    }
  }, [
    boundedViewStart,
    clock,
    maxViewStart,
    playing,
    tick,
    timelineStart,
    viewDuration,
    viewEnd,
    zoom,
  ]);
  const killTicks = useMemo(() => {
    const ticks = new Map<string, number>();
    for (const event of round.events) {
      if (event.type !== 'kill' || !event.target_id) continue;
      const previous = ticks.get(event.target_id);
      if (previous === undefined || event.tick < previous)
        ticks.set(event.target_id, event.tick);
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
      slider.current.value = String(clamp(value, boundedViewStart, viewEnd));
      slider.current.style.accentColor = phaseColor;
      slider.current.setAttribute('aria-valuetext', labelAt(value));
    }
    if (track.current) track.current.style.background = 'var(--surface-3)';
    if (elapsed.current) {
      elapsed.current.textContent = labelAt(value);
    }
  }, [
    clock,
    boundedViewStart,
    viewEnd,
    timelineStart,
    end,
    labelAt,
    round,
    tickrate,
  ]);
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
  const zoomTools: ReactNode = (
    <div
      className="replay-timeline-tools"
      role="group"
      aria-label={tr('Timeline zoom', 'Масштаб таймлайна')}
    >
      <button
        type="button"
        onClick={() => zoomAt(zoom / 1.35)}
        disabled={zoom <= 1.001}
        aria-label={tr('Zoom out', 'Уменьшить')}
        title={tr('Zoom out', 'Уменьшить')}
      >
        <Minus size={12} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        onClick={() => zoomAt(zoom * 1.35)}
        disabled={zoom >= 7.99}
        aria-label={tr('Zoom in', 'Увеличить')}
        title={tr('Zoom in', 'Увеличить')}
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        onClick={() => zoomAt(1)}
        disabled={zoom <= 1.001}
        aria-label={tr('Reset timeline zoom', 'Сбросить масштаб')}
        title={tr('Reset timeline zoom', 'Сбросить масштаб')}
      >
        <RotateCcw size={11} />
      </button>
    </div>
  );
  return (
    <>
      {zoomPortalTarget ? createPortal(zoomTools, zoomPortalTarget) : null}
      <div
        className={`replay-timeline ${zoom > 1 ? 'is-zoomed' : ''} ${dragging ? 'is-dragging' : ''}`}
        onWheel={handleWheel}
      >
        <div>
          <time ref={elapsed} className="replay-phase-time">
            {labelAt(current)}
          </time>
          <time>
            {timeLabel((end - Math.max(start, actionStart)) / tickrate)}
          </time>
        </div>
        <div
          ref={viewport}
          className="replay-timeline-viewport"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        >
          <div
            className="replay-timeline-grenade-rail"
            aria-label={tr('Grenades', 'Гранаты')}
          >
            {grenades
              .map((grenade) => ({ grenade, markerTick: grenadeTick(grenade) }))
              .filter(
                ({ markerTick }) =>
                  markerTick >= boundedViewStart && markerTick <= viewEnd,
              )
              .map(({ grenade, markerTick }) => {
                const grenadeType = grenade.data.grenade_type
                  .toLowerCase()
                  .replace(/ /g, '-');
                return (
                  <span
                    className={`replay-timeline-grenade-marker type-${grenadeType}`}
                    key={grenade.id}
                    data-tick={markerTick}
                    style={{ left: `${progress(markerTick)}%` }}
                    title={`${grenade.data.thrower} · ${grenade.data.grenade_type} · ${labelAt(markerTick)}`}
                    onMouseEnter={() => setHoveredGrenade(grenade.id)}
                    onMouseLeave={() => setHoveredGrenade(null)}
                    onFocus={() => setHoveredGrenade(grenade.id)}
                    onBlur={() => setHoveredGrenade(null)}
                  >
                    <button
                      type="button"
                      aria-label={`${grenade.data.thrower} · ${grenade.data.grenade_type}`}
                      onClick={() => onGrenadeSelect(grenade)}
                    >
                      <GrenadeMapIcon grenadeType={grenade.data.grenade_type} />
                    </button>
                    {hoveredGrenade === grenade.id && (
                      <span
                        className="replay-timeline-grenade-preview"
                        role="tooltip"
                      >
                        <span className="replay-timeline-grenade-preview-head">
                          <span
                            className={`replay-timeline-grenade-preview-icon type-${grenadeType}`}
                          >
                            <GrenadeMapIcon
                              grenadeType={grenade.data.grenade_type}
                            />
                          </span>
                          <strong>{grenade.data.grenade_type}</strong>
                          <time>{labelAt(markerTick)}</time>
                        </span>
                        <span className="replay-timeline-grenade-preview-info">
                          <b>
                            {grenade.data.thrower ||
                              tr('Unknown player', 'Неизвестный игрок')}
                          </b>
                          {typeof grenade.data.airtime === 'number' && (
                            <span>
                              {tr('Airtime', 'Полёт')}:{' '}
                              {grenade.data.airtime.toFixed(2)} s
                            </span>
                          )}
                        </span>
                      </span>
                    )}
                  </span>
                );
              })}
          </div>
          <input
            ref={slider}
            type="range"
            step="any"
            min={boundedViewStart}
            max={Math.max(boundedViewStart + 1, viewEnd)}
            defaultValue={visibleCurrent}
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
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background: color,
                }}
              />
            ))}
          </div>
          <div className="replay-event-ticks">
            {events
              .filter(
                (event) =>
                  event.tick >= boundedViewStart && event.tick <= viewEnd,
              )
              .map((event, index) => {
                const killIndex =
                  event.type === 'kill' ? killEvents.indexOf(event) : -1;
                if (killIndex < 0) {
                  return (
                    <i
                      key={index}
                      data-tick={event.tick}
                      style={{ left: `${progress(event.tick)}%` }}
                    />
                  );
                }
                const eventPlayers = playersAt(
                  round,
                  event.tick,
                  round.events,
                  killTicks,
                );
                const killer = eventPlayers.find(
                  (player) => player.id === event.player_id,
                );
                const victim = eventPlayers.find(
                  (player) => player.id === event.target_id,
                );
                const assisterId = String(event.data?.assister_id ?? '');
                const flashAssisterId = String(
                  event.data?.flash_assister_id ?? '',
                );
                const assister = eventPlayers.find(
                  (player) => player.id === assisterId,
                );
                const flashAssister = eventPlayers.find(
                  (player) => player.id === flashAssisterId,
                );
                const weapon = String(event.data?.weapon ?? '');
                const notices = [
                  event.data?.headshot === true ? 'headshot' : '',
                  event.data?.attacker_blind === true ? 'blind' : '',
                  event.data?.wallbang === true ||
                  Number(event.data?.penetrated_objects ?? 0) > 0
                    ? 'penetrate'
                    : '',
                  event.data?.through_smoke === true ? 'smoke' : '',
                  event.player_id && event.player_id === event.target_id
                    ? 'suicide'
                    : '',
                ]
                  .filter(Boolean)
                  .map((id) => ({ id, icon: deathNoticeIcon(id) }))
                  .filter((item) => item.icon);
                const isHovered = hoveredKill === killIndex;
                const edge =
                  progress(event.tick) < 18
                    ? 'is-start'
                    : progress(event.tick) > 82
                      ? 'is-end'
                      : '';
                return (
                  <span
                    className="replay-timeline-event-marker"
                    key={index}
                    data-tick={event.tick}
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
                      <span
                        className={`replay-timeline-kill-preview ${edge}`}
                        role="tooltip"
                      >
                        <time>{labelAt(event.tick)}</time>
                        <span className="replay-timeline-kill-main">
                          <b
                            className={`replay-killfeed-name ${String(killer?.side ?? 'world').toLowerCase()}`}
                          >
                            {killer?.name ?? event.player_id ?? 'World'}
                          </b>
                          {event.data?.assisted_flash === true &&
                            flashAssister && (
                              <span className="replay-timeline-kill-assist flash">
                                <img src={flashbangAssistIcon} alt="" />+
                                {flashAssister.name}
                              </span>
                            )}
                          {assister && (
                            <span className="replay-timeline-kill-assist">
                              +{assister.name}
                            </span>
                          )}
                          {weapon && (
                            <img
                              className="replay-timeline-kill-weapon"
                              src={weaponIcon(weapon)}
                              alt=""
                            />
                          )}
                          {notices.map((notice) => (
                            <img
                              className="replay-timeline-kill-notice"
                              key={notice.id}
                              src={notice.icon}
                              alt=""
                            />
                          ))}
                          <b
                            className={`replay-killfeed-name ${String(victim?.side ?? 'world').toLowerCase()}`}
                          >
                            {victim?.name ?? event.target_id ?? '—'}
                          </b>
                        </span>
                      </span>
                    )}
                  </span>
                );
              })}
          </div>
        </div>
      </div>
    </>
  );
}
