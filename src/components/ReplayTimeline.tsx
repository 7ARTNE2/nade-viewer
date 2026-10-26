import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import {
  clamp,
  roundBounds,
  roundPhaseTime,
  replayTimers,
  timeLabel,
} from '../lib/replayPlayback';
import type { ReplayEvent, ReplayRound } from '../types/replay';

type Props = {
  round: ReplayRound;
  clock: { current: number };
  tick: number;
  tickrate: number;
  playing: boolean;
  events: ReplayEvent[];
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
  onSeek,
  showFreezeTime,
}: Props) {
  const { tr } = useI18n();
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
      <div className="replay-event-ticks" aria-hidden="true">
        {events
          .filter((event) => showFreezeTime || event.tick >= actionStart)
          .map((event, index) => (
            <i key={index} style={{ left: `${progress(event.tick)}%` }} />
          ))}
      </div>
    </div>
  );
}
