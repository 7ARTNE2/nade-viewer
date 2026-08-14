import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  Clipboard,
  Clock,
  Crosshair,
  Eye,
  FileText,
  Maximize2,
  MapPinned,
  Scan,
  Timer,
  X,
} from 'lucide-react';
import MapCanvas from '../components/MapCanvas';
import GrenadeList from '../components/GrenadeList';
import ThrowKeyIcon from '../components/ThrowKeyIcon';
import {
  getGrenade,
  getSimilarGrenades,
  getSpawnPoints,
  recordGrenadeView,
  setGrenadeCore,
  assetUrl,
} from '../lib/tauri';
import { formatClock, formatNumber, grenadeLabel } from '../lib/format';
import { buildSpawnMapPoints, INSTA_LABEL, isInstaGrenade } from '../lib/insta';
import { splitThrowKeys, throwKeyVisual } from '../lib/throwKeys';
import type {
  GrenadeDetail,
  GrenadePreview,
  SpawnPoint,
} from '../types/domain';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';
import { useModalAccessibility } from '../lib/useModalAccessibility';

const detailTypeColor: Record<string, string> = {
  smoke: '#67e8f9',
  flash: '#fbbf24',
  molotov: '#fb7185',
  'incendiary grenade': '#f97316',
  HE: '#34d399',
};

const detailTypeRgb: Record<string, string> = {
  smoke: '103, 232, 249',
  flash: '251, 191, 36',
  molotov: '251, 113, 133',
  'incendiary grenade': '249, 115, 22',
  HE: '52, 211, 153',
};

export default function GrenadePage() {
  const { tr } = useI18n();
  const { showToast } = useToast();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const grenadeId = Number(id);
  const [grenade, setGrenade] = useState<GrenadeDetail | null>(null);
  const [similar, setSimilar] = useState<GrenadePreview[]>([]);
  const [spawnPoints, setSpawnPoints] = useState<SpawnPoint[]>([]);
  const [copied, setCopied] = useState(false);
  const [selectedScreenshot, setSelectedScreenshot] = useState<
    'normal' | 'wide' | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const screenshotDialogRef = useModalAccessibility<HTMLDivElement>(
    selectedScreenshot !== null,
    () => setSelectedScreenshot(null),
  );

  useEffect(() => {
    if (!Number.isInteger(grenadeId) || grenadeId <= 0) {
      navigate('/maps', { replace: true });
      return;
    }
    let cancelled = false;
    setLoadError(null);
    getGrenade(grenadeId)
      .then(async (detail) => {
        if (cancelled) return;
        setGrenade({
          ...detail,
          usage_throwers: Array.isArray(detail.usage_throwers)
            ? detail.usage_throwers
            : [],
        });
        recordGrenadeView(detail.id).catch((error) => {
          console.warn(
            `Unable to record grenade ${detail.id} in view history`,
            error,
          );
        });
        const [list, spawns] = await Promise.all([
          getSimilarGrenades(grenadeId, 10),
          getSpawnPoints(detail.map, 'Any'),
        ]);
        if (cancelled) return;
        setSimilar(Array.isArray(list) ? list : []);
        setSpawnPoints(Array.isArray(spawns) ? spawns : []);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setLoadError(
          tr(
            'This grenade is no longer available in the active library.',
            'Этой гранаты больше нет в активной библиотеке.',
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [grenadeId, navigate]);

  const previewPoint = useMemo(
    () => (grenade ? [{ ...grenade }] : []),
    [grenade],
  );
  const spawnMapPoints = useMemo(
    () => buildSpawnMapPoints(spawnPoints),
    [spawnPoints],
  );
  const isInsta = grenade ? isInstaGrenade(grenade, spawnMapPoints) : false;
  const throwKeys = splitThrowKeys(grenade?.throw_description);
  const detailAccent = grenade
    ? (detailTypeColor[grenade.grenade_type] ?? '#e5e7eb')
    : '#e5e7eb';
  const detailAccentRgb = grenade
    ? (detailTypeRgb[grenade.grenade_type] ?? '229, 231, 235')
    : '229, 231, 235';
  const selectedScreenshotPath =
    selectedScreenshot === 'normal'
      ? grenade?.screenshot_image_path
      : grenade?.screenshot_wide_image_path;
  const copy = async (text?: string | null) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      showToast(
        tr(
          'Coordinates copied. In CS2, enable sv_cheats 1, then paste setpos / setang into the console.',
          'Координаты скопированы. В CS2 включите sv_cheats 1, затем вставьте setpos / setang в консоль.',
        ),
        { tone: 'success', duration: 1960 },
      );
      window.setTimeout(() => setCopied(false), 900);
    } catch (error) {
      console.error(error);
      showToast(
        tr('Could not copy coordinates', 'Не удалось скопировать координаты'),
        { tone: 'error' },
      );
    }
  };

  const goBack = () => {
    if (!grenade) return;
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === 'number' && historyState.idx > 0) {
      navigate(-1);
      return;
    }
    navigate(`/map/${encodeURIComponent(grenade.map)}`, { replace: true });
  };

  const searchByThrower = (thrower: string) => {
    if (!grenade) return;
    navigate(`/map/${encodeURIComponent(grenade.map)}`, {
      state: { search: thrower },
    });
  };

  const handleCoreToggle = async (id: number, isCore: boolean) => {
    try {
      await setGrenadeCore(id, isCore);
      setSimilar((list) =>
        list.map((item) =>
          item.id === id ? { ...item, is_core: isCore } : item,
        ),
      );
      setGrenade((current) =>
        current && current.id === id
          ? { ...current, is_core: isCore }
          : current,
      );
      showToast(
        isCore
          ? tr('Added to Core', 'Добавлено в избранное')
          : tr('Removed from Core', 'Удалено из избранного'),
        { tone: 'success' },
      );
    } catch (error) {
      console.error(error);
      showToast(tr('Could not update Core', 'Не удалось обновить избранное'), {
        tone: 'error',
      });
    }
  };

  if (!grenade) {
    if (loadError)
      return (
        <div className="detail-load-error">
          <strong>
            {tr('Unable to open grenade', 'Не удалось открыть гранату')}
          </strong>
          <p>{loadError}</p>
          <button className="btn primary" onClick={() => navigate('/maps')}>
            {tr('Back to maps', 'К картам')}
          </button>
        </div>
      );
    return (
      <div className="detail-loading">
        <div className="loader-ring" />
      </div>
    );
  }

  return (
    <div className="grenade-detail">
      <section className="detail-map-panel">
        <div className="map-toolbar">
          <button
            className="icon-btn"
            onClick={goBack}
            aria-label={tr('Back to maps', 'К картам')}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="map-heading">
            <strong>
              {tr('Grenade', 'Граната')} #{grenade.id}
            </strong>
            <span>
              {grenade.map} / {grenadeLabel(grenade.grenade_type)}
            </span>
          </div>
        </div>
        <MapCanvas
          mapImagePath={grenade.map_image_path}
          mapLabel={grenade.map}
          grenades={previewPoint}
          spawnPoints={spawnPoints}
        />
      </section>

      <aside
        className="detail-inspector"
        style={
          {
            '--dot': detailAccent,
            '--detail-rgb': detailAccentRgb,
          } as React.CSSProperties
        }
      >
        <div className="detail-title-row">
          <span
            className={`type-pill ${String(grenade.grenade_type).toLowerCase()}`}
          >
            {grenadeLabel(grenade.grenade_type)}
          </span>
          <span className={`side-mini side-${grenade.side.toLowerCase()}`}>
            {grenade.side}
          </span>
          <strong>
            {grenade.thrower || tr('Parsed grenade', 'Распознанная граната')}
          </strong>
          {grenade.thrower_team ? (
            <span
              className={`detail-thrower-team side-accent-${grenade.side.toLowerCase()}`}
            >
              {grenade.thrower_team}
            </span>
          ) : null}
          {isInsta ? <span className="insta-badge">{INSTA_LABEL}</span> : null}
          <button
            className={`core-action detail-core ${grenade.is_core ? 'active' : ''}`}
            onClick={() => handleCoreToggle(grenade.id, !grenade.is_core)}
            aria-pressed={grenade.is_core}
          >
            <BadgeCheck size={14} />
            {grenade.is_core
              ? tr('In Core', 'В избранном')
              : tr('Add to Core', 'Добавить в избранное')}
          </button>
        </div>

        <div className="metric-grid">
          <div>
            <Timer size={14} />
            <span>{tr('Airtime', 'Время полета')}</span>
            <strong>
              {typeof grenade.airtime === 'number'
                ? `${grenade.airtime.toFixed(2)}s`
                : '-'}
            </strong>
          </div>
          <div>
            <Clock size={14} />
            <span>{tr('Round', 'Раунд')}</span>
            <strong>{formatClock(grenade.round_time_seconds)}</strong>
          </div>
          <div>
            <Crosshair size={14} />
            <span>{tr('Usage', 'Использования')}</span>
            <strong>{formatNumber(grenade.usage_count)}</strong>
          </div>
          <div>
            <MapPinned size={14} />
            <span>{tr('Tickrate', 'Тикрейт')}</span>
            <strong>{grenade.tickrate ?? '-'}</strong>
          </div>
        </div>

        <div className="info-block">
          <div className="block-title">
            {tr('Throw keys', 'Клавиши броска')}
          </div>
          {throwKeys.length ? (
            <div className="throw-preview-keys detail-throw-keys">
              {throwKeys.map((key, index) => {
                const visual = throwKeyVisual(key);
                return (
                  <span
                    className="throw-preview-key-part"
                    key={`${key}-${index}`}
                  >
                    <span
                      className={`throw-preview-key-icon ${visual.kind}`}
                      data-tip={visual.title}
                    >
                      <ThrowKeyIcon glyph={visual.glyph} />
                      <span>{visual.label}</span>
                    </span>
                    {index < throwKeys.length - 1 ? (
                      <span className="throw-preview-plus">+</span>
                    ) : null}
                  </span>
                );
              })}
            </div>
          ) : (
            <code>-</code>
          )}
        </div>

        {grenade.screenshot_image_path || grenade.screenshot_wide_image_path ? (
          <div className="info-block lineup-screenshot-block">
            <div className="block-title">
              {tr('Lineup screenshots', 'Скриншоты раскидки')}
            </div>
            <div className="lineup-screenshot-grid">
              {grenade.screenshot_image_path ? (
                <button
                  type="button"
                  className="lineup-screenshot-card"
                  onClick={() => setSelectedScreenshot('normal')}
                  aria-label={tr(
                    `Open normal FOV screenshot for grenade #${grenade.id}`,
                    `Открыть скриншот обычного FOV для гранаты #${grenade.id}`,
                  )}
                >
                  <img
                    src={assetUrl(grenade.screenshot_image_path)}
                    alt={tr(
                      `Normal FOV lineup for grenade #${grenade.id}`,
                      `Обычный FOV для гранаты #${grenade.id}`,
                    )}
                  />
                  <span className="lineup-screenshot-card-shade" />
                  <span className="lineup-screenshot-card-meta">
                    <strong>{tr('Normal', 'Обычный')}</strong>
                    <small>FOV 90</small>
                  </span>
                  <span
                    className="lineup-screenshot-card-open"
                    aria-hidden="true"
                  >
                    <Maximize2 size={14} />
                  </span>
                </button>
              ) : null}
              {grenade.screenshot_wide_image_path ? (
                <button
                  type="button"
                  className="lineup-screenshot-card"
                  onClick={() => setSelectedScreenshot('wide')}
                  aria-label={tr(
                    `Open wide FOV screenshot for grenade #${grenade.id}`,
                    `Открыть скриншот широкого FOV для гранаты #${grenade.id}`,
                  )}
                >
                  <img
                    src={assetUrl(grenade.screenshot_wide_image_path)}
                    alt={tr(
                      `Wide FOV lineup for grenade #${grenade.id}`,
                      `Широкий FOV для гранаты #${grenade.id}`,
                    )}
                  />
                  <span className="lineup-screenshot-card-shade" />
                  <span className="lineup-screenshot-card-meta">
                    <strong>{tr('Wide FOV', 'Широкий FOV')}</strong>
                    <small>{tr('Expanded view', 'Широкий обзор')}</small>
                  </span>
                  <span
                    className="lineup-screenshot-card-open"
                    aria-hidden="true"
                  >
                    <Maximize2 size={14} />
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="info-block">
          <div className="block-title">
            {tr('Coordinates', 'Координаты')}
            <button
              className={`micro-btn detail-copy-button ${copied ? 'copied' : ''}`}
              type="button"
              onClick={() => copy(grenade.coordinates)}
            >
              {copied ? (
                <Check className="copy-action-icon" size={13} />
              ) : (
                <Clipboard className="copy-action-icon" size={13} />
              )}
              {copied ? tr('Copied', 'Скопировано') : tr('Copy', 'Копировать')}
            </button>
          </div>
          <code>{grenade.coordinates || '-'}</code>
        </div>

        <div className="info-block">
          <div className="block-title">
            {tr('Demo metadata', 'Данные демо')}
          </div>
          <div className="kv-list">
            <span>{tr('Throw tick', 'Тик броска')}</span>
            <strong>{grenade.throw_tick ?? '-'}</strong>
            <span>{tr('Lineup tick', 'Тик подготовки')}</span>
            <strong>{grenade.lineup_tick ?? '-'}</strong>
            <span>{tr('Demo', 'Демо')}</span>
            <strong className="demo-filename">
              <FileText size={12} />
              {grenade.demo_filename || '-'}
            </strong>
          </div>
        </div>

        <div className="info-block usage-throwers-block">
          <div className="block-title">
            {tr('Usage throwers', 'Использовали игроки')}
            {grenade.usage_throwers.length ? (
              <span className="block-count">
                {grenade.usage_throwers.length}
              </span>
            ) : null}
          </div>
          {grenade.usage_throwers.length ? (
            <div className="thrower-list">
              {grenade.usage_throwers.map((thrower, index) => (
                <button
                  key={`${thrower}-${index}`}
                  type="button"
                  data-tip={thrower}
                  onClick={() => searchByThrower(thrower)}
                >
                  {thrower}
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-inline">-</div>
          )}
        </div>

        <div className="info-block">
          <div className="block-title">
            {tr('Similar grenades', 'Похожие гранаты')}
          </div>
          <GrenadeList
            grenades={similar}
            compact
            showCopy
            spawnPoints={spawnPoints}
            onCoreToggle={handleCoreToggle}
            emptyLabel={tr('No similar grenades.', 'Похожих гранат нет.')}
          />
        </div>
      </aside>
      {selectedScreenshot && selectedScreenshotPath
        ? createPortal(
            <div
              className="lineup-screenshot-lightbox"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget)
                  setSelectedScreenshot(null);
              }}
            >
              <div
                className="lineup-screenshot-dialog"
                ref={screenshotDialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={tr('Lineup screenshot', 'Скриншот раскидки')}
              >
                <img
                  src={assetUrl(selectedScreenshotPath)}
                  alt={tr(
                    `${selectedScreenshot === 'normal' ? 'Normal' : 'Wide FOV'} lineup for grenade #${grenade.id}`,
                    `${selectedScreenshot === 'normal' ? 'Обычный' : 'Широкий FOV'} для гранаты #${grenade.id}`,
                  )}
                  onClick={() => setSelectedScreenshot(null)}
                />
                <div className="lineup-screenshot-dialog-bar">
                  <div className="lineup-screenshot-dialog-title">
                    <span>{tr('Lineup reference', 'Ориентир раскидки')}</span>
                    <strong>
                      {selectedScreenshot === 'normal'
                        ? tr('Normal view', 'Обычный вид')
                        : tr('Wide FOV', 'Широкий FOV')}
                    </strong>
                  </div>
                </div>
                <button
                  type="button"
                  className="lineup-screenshot-close"
                  onClick={() => setSelectedScreenshot(null)}
                  aria-label={tr('Close screenshot', 'Закрыть скриншот')}
                >
                  <X size={17} />
                </button>
                <div className="lineup-screenshot-controls">
                  <div
                    className="lineup-screenshot-switch"
                    role="tablist"
                    aria-label={tr('Screenshot view', 'Вид скриншота')}
                  >
                    {grenade.screenshot_image_path ? (
                      <button
                        type="button"
                        role="tab"
                        className={
                          selectedScreenshot === 'normal' ? 'active' : ''
                        }
                        onClick={() => setSelectedScreenshot('normal')}
                        aria-selected={selectedScreenshot === 'normal'}
                      >
                        <Eye size={15} />
                        <span>{tr('Normal', 'Обычный')}</span>
                      </button>
                    ) : null}
                    {grenade.screenshot_wide_image_path ? (
                      <button
                        type="button"
                        role="tab"
                        className={
                          selectedScreenshot === 'wide' ? 'active' : ''
                        }
                        onClick={() => setSelectedScreenshot('wide')}
                        aria-selected={selectedScreenshot === 'wide'}
                      >
                        <Scan size={15} />
                        <span>{tr('Wide FOV', 'Широкий FOV')}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
