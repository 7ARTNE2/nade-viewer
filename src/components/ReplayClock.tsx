import { useI18n } from '../i18n';
import { replayTimers } from '../lib/replayPlayback';
import type { ReplayRound } from '../types/replay';

export default function ReplayClock({
  round,
  tick,
  tickrate,
}: {
  round: ReplayRound;
  tick: number;
  tickrate: number;
}) {
  const { tr } = useI18n();
  const timers = replayTimers(round, tick, tickrate);
  const bombActive = Boolean(timers.bomb);
  const label = timers.freezing
    ? tr('Freeze time', 'Фризтайм')
    : tr('Round time', 'Время раунда');
  const clockLabel = bombActive ? tr('Bomb timer', 'Таймер бомбы') : label;
  return (
    <div
      className={`replay-clocks ${bombActive ? 'has-bomb' : ''} ${timers.freezing ? 'is-freezing' : ''}`}
    >
      <span
        className="replay-round-clock"
        aria-label={clockLabel}
        title={clockLabel}
      >
        <small>
          {bombActive
            ? tr('Bomb', 'Бомба')
            : timers.freezing
              ? tr('Freeze time', 'Фризтайм')
              : tr('Round', 'Раунд')}{' '}
          {round.round.number}
        </small>
        <span className="replay-round-time">
          <time>
            {bombActive
              ? timers.bomb?.state === 'bomb_defused'
                ? tr('Defused', 'Обезврежена')
                : timers.bomb?.state === 'bomb_exploded'
                  ? tr('Exploded', 'Взорвалась')
                  : timers.bomb?.time
              : timers.round}
          </time>
        </span>
      </span>
    </div>
  );
}
