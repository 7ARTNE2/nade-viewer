import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { clamp } from '../lib/replayPlayback';
import { splitThrowKeys, throwKeyVisual } from '../lib/throwKeys';
import type { ReplayGrenade } from '../types/replay';
import GrenadeMapIcon from './GrenadeMapIcon';
import ThrowKeyIcon from './ThrowKeyIcon';
import './ReplayGrenadePreview.css';

type Props = {
  id: string;
  grenade: ReplayGrenade;
  anchor: HTMLElement;
  time: string;
};

const grenadeNames: Record<string, [string, string]> = {
  smoke: ['Smoke', 'Дымовая'],
  flash: ['Flash', 'Световая'],
  he: ['HE', 'Осколочная'],
  molotov: ['Molotov', 'Молотов'],
  'incendiary grenade': ['Incendiary', 'Зажигательная'],
};

export default function ReplayGrenadePreview({
  id,
  grenade,
  anchor,
  time,
}: Props) {
  const { tr } = useI18n();
  const preview = useRef<HTMLDivElement>(null);
  const type = grenade.data.grenade_type.toLowerCase();
  const name = grenadeNames[type];
  const keys = splitThrowKeys(grenade.data.throw_keys);
  const airtime = grenade.data.airtime;

  useLayoutEffect(() => {
    const element = preview.current;
    if (!element) return;
    const position = () => {
      const marker = anchor.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const center = marker.left + marker.width / 2;
      const left = clamp(
        center - bounds.width / 2,
        12,
        window.innerWidth - bounds.width - 12,
      );
      const above = marker.top - bounds.height - 12;
      const below = above < 12;
      element.style.left = `${left}px`;
      element.style.top = `${clamp(below ? marker.bottom + 12 : above, 12, Math.max(12, window.innerHeight - bounds.height - 12))}px`;
      element.style.setProperty(
        '--preview-arrow-left',
        `${clamp(center - left, 16, bounds.width - 16)}px`,
      );
      element.dataset.placement = below ? 'below' : 'above';
      element.style.visibility = 'visible';
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    observer.observe(anchor);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [anchor, grenade, time]);

  return createPortal(
    <div
      ref={preview}
      id={id}
      role="tooltip"
      className={`replay-grenade-preview type-${type.replace(/ /g, '-')}`}
    >
      <div className="replay-grenade-preview-header">
        <span className="replay-grenade-preview-icon">
          <GrenadeMapIcon grenadeType={type === 'he' ? 'HE' : type} />
        </span>
        <div className="replay-grenade-preview-player">
          <strong>{name ? tr(...name) : grenade.data.grenade_type}</strong>
          <span>
            {grenade.data.thrower || tr('Unknown player', 'Неизвестный игрок')}
          </span>
        </div>
        <div className="replay-grenade-preview-timing">
          <time>{time}</time>
          {typeof airtime === 'number' && Number.isFinite(airtime) && (
            <span>
              {tr('Airtime', 'Полёт')}{' '}
              <b>
                {airtime.toFixed(2)} {tr('s', 'с')}
              </b>
            </span>
          )}
        </div>
      </div>
      <div className="replay-grenade-preview-inputs">
        <span className="replay-grenade-preview-label">
          {tr('Throw keys', 'Клавиши броска')}
        </span>
        {keys.length > 0 ? (
          <div className="throw-preview-keys">
            {keys.map((key, index) => {
              const visual = throwKeyVisual(key);
              return (
                <span
                  className="throw-preview-key-part"
                  key={`${key}-${index}`}
                >
                  <span
                    className={`throw-preview-key-icon ${visual.kind} ${visual.iconOnly ? 'icon-only' : ''}`}
                    data-tip={visual.title}
                  >
                    {visual.iconOnly ? (
                      visual.kind === 'mouse' ? (
                        <>
                          <span>{visual.label}</span>
                          <ThrowKeyIcon glyph={visual.glyph} />
                        </>
                      ) : (
                        <ThrowKeyIcon glyph={visual.glyph} />
                      )
                    ) : (
                      <span>{visual.label}</span>
                    )}
                  </span>
                </span>
              );
            })}
          </div>
        ) : (
          <span className="replay-grenade-preview-empty">
            {tr('Not recorded', 'Не записаны')}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
