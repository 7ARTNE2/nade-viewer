import { useI18n } from '../i18n';
import { replayAssists } from '../lib/replayAssists';
import type { ReplayEvent, ReplayPlayer } from '../types/replay';
import flashbangAssistIcon from '../assets/equipment_icons/flashbang_assist.svg';
import './ReplayKillAssists.css';

export default function ReplayKillAssists({
  event,
  players,
  events,
  tickrate,
  className,
}: {
  event: ReplayEvent;
  players: ReplayPlayer[];
  events: ReplayEvent[];
  tickrate: number;
  className: string;
}) {
  const { tr } = useI18n();
  return (
    <>
      {replayAssists(event, players, events, tickrate).map(
        ({ type, player }) => (
          <span
            key={`${type}-${player?.id ?? 'unknown'}`}
            className={`${className} replay-kill-assist ${type} ${String(player?.side ?? 'world').toLowerCase()}`}
            data-tip={
              type === 'flash'
                ? tr('Flash assist', 'Ассист флешкой')
                : tr('Damage assist', 'Ассист по урону')
            }
          >
            {type === 'flash' && (
              <img
                className="replay-killfeed-assist-icon"
                src={flashbangAssistIcon}
                alt={tr('Flash assist', 'Ассист флешкой')}
              />
            )}
            {player ? `+${player.name}` : ''}
          </span>
        ),
      )}
    </>
  );
}
