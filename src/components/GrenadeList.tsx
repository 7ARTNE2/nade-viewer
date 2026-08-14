import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, Check, Clipboard } from 'lucide-react';
import { formatClock, grenadeLabel } from '../lib/format';
import { buildSpawnMapPoints, INSTA_LABEL, isInstaGrenade } from '../lib/insta';
import type { GrenadePreview, SpawnPoint } from '../types/domain';
import { useI18n } from '../i18n';
import { useToast } from './Toast';
import ThrowKeyIcon from './ThrowKeyIcon';
import { splitThrowKeys, throwKeyVisual } from '../lib/throwKeys';

type Props = {
  grenades: GrenadePreview[];
  compact?: boolean;
  showCopy?: boolean;
  spawnPoints?: SpawnPoint[];
  onCoreToggle?: (id: number, isCore: boolean) => void;
  emptyLabel?: string;
  loading?: boolean;
};

export default function GrenadeList({
  grenades,
  compact,
  showCopy,
  spawnPoints = [],
  onCoreToggle,
  emptyLabel,
  loading = false,
}: Props) {
  const { tr } = useI18n();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const spawnMapPoints = useMemo(
    () => buildSpawnMapPoints(spawnPoints),
    [spawnPoints],
  );

  const copyGrenadeText = async (grenade: GrenadePreview) => {
    const text = grenade.coordinates || grenade.throw_description;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(grenade.id);
      showToast(
        tr(
          'Coordinates copied. In CS2, enable sv_cheats 1, then paste setpos / setang into the console.',
          'Координаты скопированы. В CS2 включите sv_cheats 1, затем вставьте setpos / setang в консоль.',
        ),
        { tone: 'success', duration: 1960 },
      );
      window.setTimeout(() => setCopiedId(null), 900);
    } catch (error) {
      console.error(error);
      showToast(
        tr('Could not copy coordinates', 'Не удалось скопировать координаты'),
        { tone: 'error' },
      );
    }
  };

  if (loading) {
    return (
      <div className="nade-list compact nade-list-skeleton" aria-live="polite">
        <span className="sr-only">
          {tr('Loading grenades', 'Загрузка гранат')}
        </span>
        {Array.from({ length: 4 }, (_, index) => (
          <div className="nade-row" key={index} aria-hidden="true">
            <span className="nade-skeleton-type" />
            <span className="nade-skeleton-side" />
            <span className="nade-skeleton-main">
              <i />
              <i />
            </span>
            <span className="nade-skeleton-action" />
          </div>
        ))}
      </div>
    );
  }

  if (!grenades.length) {
    return (
      <div className="empty-note">
        {emptyLabel ??
          tr(
            'Select a landing cluster to load grenades.',
            'Выберите кластер приземления, чтобы загрузить гранаты.',
          )}
      </div>
    );
  }

  return (
    <div className={compact ? 'nade-list compact' : 'nade-list'}>
      {grenades.map((g) => {
        const isInsta = isInstaGrenade(g, spawnMapPoints);
        const throwKeys = splitThrowKeys(g.throw_description);
        return (
          <div
            key={g.id}
            className={`nade-row type-${String(g.grenade_type).toLowerCase()} ${g.is_core ? 'core' : ''} ${isInsta ? 'insta' : ''}`}
          >
            <div className="nade-type-stack">
              <span
                className={`type-pill ${String(g.grenade_type).toLowerCase()}`}
              >
                {grenadeLabel(g.grenade_type)}
              </span>
              {showCopy ? (
                <button
                  type="button"
                  className={`copy-action ${copiedId === g.id ? 'copied' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    copyGrenadeText(g);
                  }}
                  disabled={!g.coordinates && !g.throw_description}
                  aria-label={tr(
                    'Copy grenade coordinates',
                    'Копировать координаты гранаты',
                  )}
                  data-tip={
                    copiedId === g.id
                      ? tr('Copied', 'Скопировано')
                      : tr('Copy coordinates', 'Копировать координаты')
                  }
                >
                  {copiedId === g.id ? (
                    <Check className="copy-action-icon" size={13} />
                  ) : (
                    <Clipboard className="copy-action-icon" size={13} />
                  )}
                  <span>
                    {copiedId === g.id
                      ? tr('Copied', 'Скопировано')
                      : tr('Copy', 'Копировать')}
                  </span>
                </button>
              ) : null}
            </div>
            <span className={`side-mini side-${g.side.toLowerCase()}`}>
              {g.side}
            </span>
            <button
              className="nade-main nade-open-action"
              type="button"
              onClick={() => navigate(`/grenade/${g.id}`)}
              aria-label={`${grenadeLabel(g.grenade_type)} ${g.thrower || `${tr('Grenade', 'Граната')} #${g.id}`}`}
            >
              <span className="nade-title-line">
                <strong>
                  {g.thrower || `${tr('Grenade', 'Граната')} #${g.id}`}
                </strong>
                {g.thrower_team ? (
                  <span
                    className={`nade-thrower-team side-accent-${g.side.toLowerCase()}`}
                  >
                    {g.thrower_team}
                  </span>
                ) : null}
                {isInsta ? (
                  <span className="insta-badge">{INSTA_LABEL}</span>
                ) : null}
                {g.is_core ? (
                  <span className="core-badge">{tr('Core', 'Избранное')}</span>
                ) : null}
              </span>
            </button>
            <div className="nade-action-stack">
              <button
                type="button"
                className={`core-action ${g.is_core ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCoreToggle?.(g.id, !g.is_core);
                }}
                aria-label={
                  g.is_core
                    ? tr('Remove from Core', 'Удалить из избранного')
                    : tr('Add to Core', 'Добавить в избранное')
                }
                aria-pressed={g.is_core}
                data-tip={
                  g.is_core
                    ? tr('In Core', 'В избранном')
                    : tr('Add to Core', 'Добавить в избранное')
                }
              >
                <BadgeCheck size={14} />
                <span>
                  {g.is_core
                    ? tr('In Core', 'В избранном')
                    : tr('Add to Core', 'Добавить в избранное')}
                </span>
              </button>
            </div>
            <span
              className="nade-stats"
              aria-label={tr('Grenade statistics', 'Статистика гранаты')}
            >
              <span className="nade-stat usage">
                <small>{tr('Usage', 'Использований')}</small>
                <b>{g.usage_count}x</b>
              </span>
              {typeof g.airtime === 'number' ? (
                <span className="nade-stat air">
                  <small>{tr('Air', 'Полёт')}</small>
                  <b>{g.airtime.toFixed(2)}s</b>
                </span>
              ) : null}
              {typeof g.round_time_seconds === 'number' ? (
                <span className="nade-stat round">
                  <small>{tr('Round', 'Раунд')}</small>
                  <b>{formatClock(g.round_time_seconds)}</b>
                </span>
              ) : null}
            </span>
            {throwKeys.length ? (
              <span className="nade-throw-keys" aria-label={tr('Throw keys', 'Клавиши броска')}>
                <span className="nade-throw-keys-label">{tr('Keys', 'Клавиши')}</span>
                <span className="nade-throw-key-list">
                  {throwKeys.map((key) => {
                    const visual = throwKeyVisual(key);
                    return (
                      <span
                        key={key}
                        className={`nade-throw-key ${visual.kind} ${visual.iconOnly ? 'icon-only' : ''}`}
                        data-tip={visual.title}
                      >
                        {visual.iconOnly ? (
                          visual.kind === 'mouse' ? (
                            <>
                              <b>{visual.label}</b>
                              <ThrowKeyIcon glyph={visual.glyph} />
                            </>
                          ) : (
                            <ThrowKeyIcon glyph={visual.glyph} />
                          )
                        ) : (
                          <b>{visual.label}</b>
                        )}
                      </span>
                    );
                  })}
                </span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
