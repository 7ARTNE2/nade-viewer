import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Clock3 } from 'lucide-react';
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
};

export default function ReplayTimeline({
  round,
  clock,
  tick,
  tickrate,
  playing,
  events,
  onSeek,
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
  const progress = (value: number) =>
    clamp(((value - start) / (end - start || 1)) * 100, 0, 100);
  const current = clamp(clock.current, start, end);
  const freezeProgress = progress(actionStart);
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
    const value = clamp(clock.current, start, end);
    if (slider.current) {
      slider.current.value = String(value);
    }
    if (track.current)
      track.current.style.background = `linear-gradient(90deg, var(--acid) ${clamp(((value - start) / (end - start || 1)) * 100, 0, 100)}%, var(--surface-3) 0)`;
    if (elapsed.current) {
      elapsed.current.textContent = labelAt(value);
    }
  }, [clock, start, end, labelAt]);
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
        <span className="replay-timeline-round">
          <Clock3 size={11} />
          {tr('Round', 'Раунд')} {round.round.number}
        </span>
        <time>
          {timeLabel((end - Math.max(start, actionStart)) / tickrate)}
        </time>
      </div>
      <input
        ref={slider}
        type="range"
        min={start}
        max={Math.max(start + 1, end)}
        step="any"
        defaultValue={current}
        aria-label={tr('Replay timeline', 'Таймлайн повтора')}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <div
        ref={track}
        className="replay-timeline-track"
        style={{
          background: `linear-gradient(90deg, var(--acid) ${progress(current)}%, var(--surface-3) 0)`,
        }}
      >
        {freezeProgress > 0 && (
          <span
            className="replay-freeze-segment"
            style={{ width: `${freezeProgress}%` }}
            title={freezeLabel}
            aria-hidden="true"
          />
        )}
        {plant && progress(bombEnd) > progress(plant.tick) && (
          <span
            className="replay-bomb-segment"
            style={{
              left: `${progress(plant.tick)}%`,
              width: `${progress(bombEnd) - progress(plant.tick)}%`,
            }}
            aria-label={tr('Bomb time', 'Время бомбы')}
          />
        )}
      </div>
      <div className="replay-event-ticks" aria-hidden="true">
        {events.map((event, index) => (
          <i key={index} style={{ left: `${progress(event.tick)}%` }} />
        ))}
      </div>
    </div>
  );
}
