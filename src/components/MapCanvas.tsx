import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, Crosshair, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { assetUrl } from '../lib/tauri';
import { formatNumber, grenadeLabel } from '../lib/format';
import { buildSpawnMapPoints, INSTA_LABEL, isInstaGrenade } from '../lib/insta';
import { splitThrowKeys, throwKeyVisual } from '../lib/throwKeys';
import ThrowKeyIcon from './ThrowKeyIcon';
import GrenadeMapIcon from './GrenadeMapIcon';
import type {
  GrenadePreview,
  LandingCluster,
  SpawnPoint,
} from '../types/domain';
import { useI18n } from '../i18n';
import { useToast } from './Toast';

type Props = {
  mapImagePath?: string | null;
  mapLabel?: string | null;
  clusters?: LandingCluster[];
  selectedClusterId?: string | null;
  grenades?: GrenadePreview[];
  grenadePointMode?: 'throw' | 'landing';
  spawnPoints?: SpawnPoint[];
  showSpawns?: boolean;
  iconTheme?: IconTheme;
  onClusterSelect?: (cluster: LandingCluster) => void;
  onGrenadeOpen?: (id: number) => void;
};

export type IconTheme = 'base' | 'asset';

const typeColor: Record<string, string> = {
  smoke: '#67e8f9',
  flash: '#fbbf24',
  molotov: '#fb7185',
  'incendiary grenade': '#f97316',
  HE: '#34d399',
};
const sideColor: Record<string, string> = {
  T: '#f97316',
  CT: '#60a5fa',
  MIX: '#a78bfa',
  NEUTRAL: '#e5e7eb',
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const grenadePoint = (grenade: GrenadePreview, mode: 'throw' | 'landing') => {
  const x = mode === 'landing' ? grenade.explode_map_x : grenade.start_map_x;
  const y = mode === 'landing' ? grenade.explode_map_y : grenade.start_map_y;
  return typeof x === 'number' && typeof y === 'number'
    ? ([x, y] as [number, number])
    : null;
};
const splitCommands = (value?: string | null) =>
  value
    ? value
        .replace(/\s+(setang|setpos)\b/gi, '\n$1')
        .split(/[;\n]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

type ThrowGroup = {
  id: string;
  x: number;
  y: number;
  grenades: GrenadePreview[];
};
const groupThrowPoints = (
  items: GrenadePreview[],
  mode: 'throw' | 'landing',
): ThrowGroup[] => {
  const buckets = new Map<
    string,
    { x: number; y: number; sx: number; sy: number; grenades: GrenadePreview[] }
  >();
  items.forEach((grenade) => {
    const point = grenadePoint(grenade, mode);
    if (!point) return;
    const [x, y] = point;
    const key = `${Math.floor(x / 11)}:${Math.floor(y / 11)}`;
    const current = buckets.get(key);
    if (current && Math.hypot(current.x - x, current.y - y) <= 8) {
      current.grenades.push(grenade);
      current.sx += x;
      current.sy += y;
      current.x = current.sx / current.grenades.length;
      current.y = current.sy / current.grenades.length;
    } else {
      buckets.set(current ? `${key}:${grenade.id}` : key, {
        x,
        y,
        sx: x,
        sy: y,
        grenades: [grenade],
      });
    }
  });
  return [...buckets.values()].map((group) => {
    const grenades = [...group.grenades].sort(
      (a, b) =>
        Number(b.is_core) - Number(a.is_core) ||
        b.usage_count - a.usage_count ||
        a.id - b.id,
    );
    return {
      id: grenades.map((grenade) => grenade.id).join('-'),
      x: group.x,
      y: group.y,
      grenades,
    };
  });
};

export default function MapCanvas({
  mapImagePath,
  mapLabel,
  clusters = [],
  selectedClusterId,
  grenades = [],
  grenadePointMode = 'throw',
  spawnPoints = [],
  showSpawns = true,
  iconTheme = 'base',
  onClusterSelect,
  onGrenadeOpen,
}: Props) {
  const { tr, count } = useI18n();
  const { showToast } = useToast();
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
    s: number;
    moved: boolean;
  } | null>(null);
  const draggedRef = useRef(false);
  const stageSizeRef = useRef({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const [copied, setCopied] = useState<number | null>(null);
  const [copiedGrenadeId, setCopiedGrenadeId] = useState<number | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    grenade: GrenadePreview;
    x: number;
    y: number;
  } | null>(null);
  const [coordinateMenu, setCoordinateMenu] = useState<{
    grenades: GrenadePreview[];
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => {
      const nextSize = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      };
      stageSizeRef.current = nextSize;
      setStageSize(nextSize);
      setView((current) => {
        if (current.s <= 1) return { s: 1, tx: 0, ty: 0 };
        return {
          s: current.s,
          tx: clamp(current.tx, nextSize.width - nextSize.width * current.s, 0),
          ty: clamp(
            current.ty,
            nextSize.height - nextSize.height * current.s,
            0,
          ),
        };
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if ((event.buttons & 1) === 0) {
        dragRef.current = null;
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
        return;
      }
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 3)
          return;
        drag.moved = true;
        draggedRef.current = true;
      }
      const tx = drag.tx + event.clientX - drag.x;
      const ty = drag.ty + event.clientY - drag.y;
      const size = stageSizeRef.current;
      const next =
        drag.s <= 1 || size.width <= 0 || size.height <= 0
          ? { s: 1, tx: 0, ty: 0 }
          : {
              s: drag.s,
              tx: clamp(tx, size.width - size.width * drag.s, 0),
              ty: clamp(ty, size.height - size.height * drag.s, 0),
            };
      setView(next);
      event.preventDefault();
    };
    const end = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      window.setTimeout(() => {
        draggedRef.current = false;
      }, 0);
    };
    window.addEventListener('mousemove', move, { passive: false });
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
    };
  }, []);

  const selectedCluster = clusters.find(
    (cluster) => cluster.id === selectedClusterId,
  );
  const image = assetUrl(mapImagePath);
  const spawnMapPoints = useMemo(
    () => buildSpawnMapPoints(spawnPoints),
    [spawnPoints],
  );
  const groups = useMemo(
    () => groupThrowPoints(grenades, grenadePointMode),
    [grenades, grenadePointMode],
  );
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const radarSize = Math.min(stageSize.width, stageSize.height);
  const radarOffsetX = (stageSize.width - radarSize) / 2;
  const radarOffsetY = (stageSize.height - radarSize) / 2;
  const project = (x: number, y: number) =>
    ({
      '--map-x': `${(radarOffsetX + (x / 1024) * radarSize) * view.s + view.tx}px`,
      '--map-y': `${(radarOffsetY + (y / 1024) * radarSize) * view.s + view.ty}px`,
    }) as CSSProperties;
  const projectSvg = (x: number, y: number) => ({
    x: (radarOffsetX + (x / 1024) * radarSize) * view.s + view.tx,
    y: (radarOffsetY + (y / 1024) * radarSize) * view.s + view.ty,
  });
  const clampView = (s: number, tx: number, ty: number) => {
    if (s <= 1 || stageSize.width <= 0 || stageSize.height <= 0)
      return { s: 1, tx: 0, ty: 0 };
    return {
      s,
      tx: clamp(tx, stageSize.width - stageSize.width * s, 0),
      ty: clamp(ty, stageSize.height - stageSize.height * s, 0),
    };
  };
  const resetView = () => setView({ s: 1, tx: 0, ty: 0 });
  const zoomAt = (
    factor: number,
    x = stageSize.width / 2,
    y = stageSize.height / 2,
  ) =>
    setView((current) => {
      const s = clamp(current.s * factor, 1, 6);
      const ratio = s / current.s;
      return clampView(
        s,
        x - (x - current.tx) * ratio,
        y - (y - current.ty) * ratio,
      );
    });
  const copySpawn = async (spawn: SpawnPoint, index: number) => {
    try {
      await navigator.clipboard.writeText(spawn.command);
      setCopied(index);
      showToast(
        tr(
          'Spawn coordinates copied. In CS2, enable sv_cheats 1, then paste setpos / setang into the console.',
          'Координаты спавна скопированы. В CS2 включите sv_cheats 1, затем вставьте setpos / setang в консоль.',
        ),
        { tone: 'success', duration: 6200 },
      );
      window.setTimeout(() => setCopied(null), 1400);
    } catch (error) {
      console.error(error);
      showToast(
        tr(
          'Could not copy spawn coordinates',
          'Не удалось скопировать координаты спавна',
        ),
        { tone: 'error' },
      );
    }
  };
  const copyGrenadeCoordinates = async (grenade: GrenadePreview) => {
    if (!grenade.coordinates) return;
    try {
      await navigator.clipboard.writeText(grenade.coordinates);
      setCopiedGrenadeId(grenade.id);
      showToast(
        tr(
          'Coordinates copied. In CS2, enable sv_cheats 1, then paste setpos / setang into the console.',
          'Координаты скопированы. В CS2 включите sv_cheats 1, затем вставьте setpos / setang в консоль.',
        ),
        { tone: 'success', duration: 6200 },
      );
      window.setTimeout(() => setCopiedGrenadeId(null), 1400);
    } catch (error) {
      console.error(error);
      showToast(
        tr('Could not copy coordinates', 'Не удалось скопировать координаты'),
        { tone: 'error' },
      );
    }
  };
  const showCoordinateMenu = (
    event: ReactMouseEvent,
    grenades: GrenadePreview[],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const items = grenades.filter((grenade) => grenade.coordinates);
    if (!items.length) return;
    if (items.length === 1) {
      copyGrenadeCoordinates(items[0]);
      return;
    }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPreview(null);
    setCoordinateMenu({
      grenades: items,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };
  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (view.s <= 1) return;
    if (
      target.closest(
        '.map-toolbar-floating, .throw-strip, .throw-preview-popover',
      )
    )
      return;
    draggedRef.current = false;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: view.tx,
      ty: view.ty,
      s: view.s,
      moved: false,
    };
  };
  const suppressDraggedClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!draggedRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect)
      zoomAt(
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
  };
  const panBy = (x: number, y: number) => {
    setView((current) => clampView(current.s, current.tx + x, current.ty + y));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const panDistance = Math.max(
      32,
      Math.min(stageSize.width, stageSize.height) * 0.1,
    );
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        zoomAt(1.18);
        break;
      case '-':
      case '_':
        event.preventDefault();
        zoomAt(1 / 1.18);
        break;
      case '0':
      case 'Home':
        event.preventDefault();
        resetView();
        break;
      case 'ArrowUp':
        event.preventDefault();
        panBy(0, panDistance);
        break;
      case 'ArrowDown':
        event.preventDefault();
        panBy(0, -panDistance);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        panBy(panDistance, 0);
        break;
      case 'ArrowRight':
        event.preventDefault();
        panBy(-panDistance, 0);
        break;
    }
  };
  const showPreview = (event: ReactPointerEvent, grenade: GrenadePreview) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect)
      setPreview({
        grenade,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
  };
  const previewKeys = splitThrowKeys(preview?.grenade.throw_description);
  const previewCommands = splitCommands(preview?.grenade.coordinates);
  const previewStyle = preview
    ? ({
        left: clamp(
          preview.x + 16,
          12,
          Math.max(12, (viewportRef.current?.clientWidth ?? 0) - 332),
        ),
        top: clamp(
          preview.y + 14,
          12,
          Math.max(12, (viewportRef.current?.clientHeight ?? 0) - 232),
        ),
        '--dot': typeColor[preview.grenade.grenade_type] ?? '#fff',
      } as CSSProperties)
    : undefined;

  const markerIcon = (grenadeType: string) =>
    iconTheme === 'asset' ? (
      <GrenadeMapIcon grenadeType={grenadeType} />
    ) : (
      <Crosshair size={10} />
    );

  return (
    <div
      className={`map-canvas icon-theme-${iconTheme}`}
      data-tour="map-canvas"
    >
      <div className="map-toolbar-floating" data-map-control="1">
        <button
          onClick={() => zoomAt(1.18)}
          aria-label={tr('Zoom in', 'Приблизить')}
          data-tip={tr('Zoom in', 'Приблизить')}
        >
          <Plus size={16} />
        </button>
        <button
          onClick={() => zoomAt(1 / 1.18)}
          aria-label={tr('Zoom out', 'Отдалить')}
          data-tip={tr('Zoom out', 'Отдалить')}
        >
          <Minus size={16} />
        </button>
        <button
          onClick={resetView}
          aria-label={tr('Reset view', 'Сбросить вид')}
          data-tip={tr('Reset view', 'Сбросить вид')}
          className="reset"
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <details className="map-legend" data-map-control="1">
        <summary>{tr('Map legend', 'Легенда карты')}</summary>
        <div className="map-legend-content">
          <div className="legend-group legend-clusters">
            <strong>{tr('Clusters', 'Кластеры')}</strong>
            <span>
              <i className="legend-dot t" /> {tr('T side', 'Сторона T')}
            </span>
            <span>
              <i className="legend-dot ct" /> {tr('CT side', 'Сторона CT')}
            </span>
            <span>
              <i className="legend-dot mix" />{' '}
              {tr('Mixed sides', 'Смешанные стороны')}
            </span>
          </div>
          <div className="legend-group legend-lineups">
            <strong>{tr('Lineups', 'Раскидки')}</strong>
            <span>
              <i className="legend-throw" />{' '}
              {tr(
                'One lineup: click to open',
                'Одна раскидка: нажмите, чтобы открыть',
              )}
            </span>
            <span>
              <i className="legend-throw legend-stack">2</i>{' '}
              {tr(
                'Several lineups: click to choose',
                'Несколько раскидок: нажмите для выбора',
              )}
            </span>
            <span>
              <i className="legend-throw legend-core" />{' '}
              {tr('Core lineup', 'Избранная раскидка')}
            </span>
            <span>
              <i className="legend-throw legend-insta" />{' '}
              {tr('Spawn match', 'Совпадение со спавном')}
            </span>
            <small>
              {tr(
                'Right-click a lineup point to copy coordinates',
                'ПКМ по точке раскидки: копировать координаты',
              )}
            </small>
          </div>
          <div className="legend-group legend-types">
            <strong>
              {tr('Grenade type and trajectory', 'Тип гранаты и траектория')}
            </strong>
            <span>
              <i className="legend-line smoke" /> {tr('Smoke', 'Смок')}
            </span>
            <span>
              <i className="legend-line flash" /> {tr('Flash', 'Флешка')}
            </span>
            <span>
              <i className="legend-line molotov" /> {tr('Molotov', 'Молотов')}
            </span>
            <span>
              <i className="legend-line incendiary" />{' '}
              {tr('Incendiary', 'Зажигательная')}
            </span>
            <span>
              <i className="legend-line he" /> HE
            </span>
          </div>
          <div className="legend-group legend-spawns">
            <strong>{tr('Spawns', 'Спавны')}</strong>
            <span>
              <i className="legend-spawn t" /> {tr('T spawn', 'Спавн T')}
            </span>
            <span>
              <i className="legend-spawn ct" /> {tr('CT spawn', 'Спавн CT')}
            </span>
            <small>
              {tr(
                'Click a spawn to copy its command',
                'Нажмите на спавн, чтобы скопировать команду',
              )}
            </small>
          </div>
        </div>
      </details>
      <div className="map-interaction-hint" id="map-interaction-hint">
        {tr(
          'Mouse wheel: zoom. Drag: pan when zoomed. Arrow keys: pan. + / -: zoom. 0: reset.',
          'Колесо: масштаб. Перетаскивание: перемещение при увеличении. Стрелки: перемещение. + / -: масштаб. 0: сброс.',
        )}
      </div>
      <div
        ref={viewportRef}
        className={`map-viewport ${view.s > 1 ? 'is-draggable' : ''}`}
        tabIndex={0}
        role="region"
        aria-label={tr(
          `Interactive tactical map of ${mapLabel ?? 'the selected map'}`,
          `Интерактивная тактическая карта ${mapLabel ?? 'выбранной карты'}`,
        )}
        aria-describedby="map-interaction-hint"
        onMouseDownCapture={onMouseDown}
        onClickCapture={suppressDraggedClick}
        onContextMenu={(event) => {
          if (coordinateMenu) {
            event.preventDefault();
            setCoordinateMenu(null);
          }
        }}
        onDragStart={(event) => event.preventDefault()}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <div
          ref={stageRef}
          className="map-stage"
          style={
            stageSize.width && stageSize.height
              ? { width: stageSize.width, height: stageSize.height }
              : undefined
          }
        >
          <div
            className="map-world"
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
            }}
          >
            {image ? (
              <img
                src={image}
                alt={tr(
                  `Tactical map of ${mapLabel ?? 'the selected map'}`,
                  `Тактическая карта ${mapLabel ?? 'выбранной карты'}`,
                )}
                className="map-image"
                draggable={false}
                style={{
                  width: radarSize,
                  height: radarSize,
                  left: radarOffsetX,
                  top: radarOffsetY,
                }}
              />
            ) : (
              <div className="map-empty">
                {tr('No map image', 'Нет изображения карты')}
              </div>
            )}
          </div>
          {selectedCluster ? (
            <div className="map-caption">
              <span>
                {count(
                  selectedCluster.count,
                  'grenade selected',
                  'grenades selected',
                  'граната выбрана',
                  'гранаты выбрано',
                  'гранат выбрано',
                )}
              </span>
              <span>
                {selectedCluster.unique_types.map(grenadeLabel).join(', ')}
              </span>
            </div>
          ) : null}
          <svg
            className="trajectory-screen-layer"
            width={stageSize.width}
            height={stageSize.height}
            viewBox={`0 0 ${stageSize.width || 1} ${stageSize.height || 1}`}
          >
            {grenades.map((grenade) => {
              const trajectory = Array.isArray(grenade.trajectory_preview)
                ? grenade.trajectory_preview.filter(
                    (point): point is [number, number] =>
                      Array.isArray(point) &&
                      Number.isFinite(point[0]) &&
                      Number.isFinite(point[1]),
                  )
                : [];
              if (!trajectory.length) return null;
              const start =
                typeof grenade.start_map_x === 'number' &&
                typeof grenade.start_map_y === 'number'
                  ? projectSvg(grenade.start_map_x, grenade.start_map_y)
                  : null;
              const first = projectSvg(...trajectory[0]);
              return (
                <g key={`trajectory-${grenade.id}`}>
                  {start ? (
                    <line
                      className="trajectory-connector"
                      x1={start.x}
                      y1={start.y}
                      x2={first.x}
                      y2={first.y}
                    />
                  ) : null}
                  <polyline
                    points={trajectory
                      .map(([x, y]) => {
                        const point = projectSvg(x, y);
                        return `${point.x},${point.y}`;
                      })
                      .join(' ')}
                    fill="none"
                    stroke={
                      typeColor[grenade.grenade_type] ?? 'rgba(255,255,255,.72)'
                    }
                    strokeOpacity=".72"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            })}
          </svg>
          <div className="absolute-layer marker-layer">
            {showSpawns &&
              spawnPoints.map((spawn, index) =>
                typeof spawn.map_x === 'number' &&
                typeof spawn.map_y === 'number' ? (
                  <button
                    key={`${spawn.side}-${index}-${spawn.pos_x}-${spawn.pos_y}`}
                    className={`spawn-dot ${spawn.side === 'CT' ? 'ct' : 't'} ${copied === index ? 'coordinates-copied' : ''}`}
                    style={project(spawn.map_x, spawn.map_y)}
                    data-map-control="1"
                    onClick={() => copySpawn(spawn, index)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      copySpawn(spawn, index);
                    }}
                    data-tip={`${spawn.command} / ${spawn.side}`}
                    aria-label={tr(
                      `${spawn.side} spawn. Copy coordinates.`,
                      `Спавн ${spawn.side}. Копировать координаты.`,
                    )}
                  >
                    <span className="spawn-pulse" />
                    <span
                      className={`spawn-core ${copied === index ? 'copied' : ''}`}
                    />
                  </button>
                ) : null,
              )}
            {clusters
              .filter(
                (cluster) =>
                  !selectedClusterId || cluster.id === selectedClusterId,
              )
              .map((cluster) => {
                const singleType =
                  cluster.unique_types.length === 1
                    ? cluster.unique_types[0]
                    : null;
                return (
                  <button
                    key={cluster.id}
                    className={`cluster-dot ${singleType ? 'single-type ' : ''}${grenadePointMode === 'landing' ? 'cluster-dot--throw ' : ''}${cluster.id === selectedClusterId ? 'selected' : ''}`}
                    style={
                      {
                        ...project(cluster.x, cluster.y),
                        '--dot':
                          sideColor[cluster.side_key] ?? sideColor.NEUTRAL,
                      } as CSSProperties
                    }
                    data-map-control="1"
                    onClick={() => onClusterSelect?.(cluster)}
                    data-tip={count(
                      cluster.count,
                      'grenade',
                      'grenades',
                      'граната',
                      'гранаты',
                      'гранат',
                    )}
                    aria-label={tr(
                      `${cluster.side_key} cluster, ${cluster.count} grenades. Open cluster.`,
                      `Кластер ${cluster.side_key}, ${cluster.count} гранат. Открыть кластер.`,
                    )}
                  >
                    {iconTheme === 'asset' && singleType ? (
                      <GrenadeMapIcon grenadeType={singleType} />
                    ) : null}
                    <span>{cluster.count}</span>
                  </button>
                );
              })}
            {groups.map((group) => {
              const grenade = group.grenades[0];
              const matched =
                grenadePointMode === 'throw' &&
                group.grenades.some((item) =>
                  isInstaGrenade(item, spawnMapPoints),
                );
              const style = {
                ...project(group.x, group.y),
                '--dot': typeColor[grenade.grenade_type] ?? '#fff',
              } as CSSProperties;
              return group.grenades.length > 1 ? (
                <div
                  key={group.id}
                  className="throw-cluster-wrap"
                  style={style}
                  data-map-control="1"
                >
                  <button
                    className={`throw-dot throw-stack-dot ${group.grenades.some((item) => item.is_core) ? 'core' : ''} ${matched ? 'spawn-match' : ''} ${group.grenades.some((item) => item.id === copiedGrenadeId) ? 'coordinates-copied' : ''}`}
                    onClick={() =>
                      setActiveGroupId(
                        activeGroupId === group.id ? null : group.id,
                      )
                    }
                    onContextMenu={(event) =>
                      showCoordinateMenu(event, group.grenades)
                    }
                    data-tip={`${matched ? `${INSTA_LABEL} / ` : ''}${group.grenades.length} points`}
                    aria-label={tr(
                      `${group.grenades.length} grenade points. Choose a lineup.`,
                      `${group.grenades.length} точек гранат. Выбрать раскидку.`,
                    )}
                  >
                    {iconTheme === 'asset'
                      ? markerIcon(grenade.grenade_type)
                      : null}
                    {group.grenades.some(
                      (item) => item.id === copiedGrenadeId,
                    ) ? (
                      <Check size={13} />
                    ) : (
                      <span>{group.grenades.length}</span>
                    )}
                  </button>
                </div>
              ) : (
                <button
                  key={group.id}
                  className={`throw-dot ${grenade.is_core ? 'core' : ''} ${matched ? 'spawn-match' : ''} ${grenade.id === copiedGrenadeId ? 'coordinates-copied' : ''}`}
                  style={style}
                  data-map-control="1"
                  onPointerEnter={(event) => showPreview(event, grenade)}
                  onPointerMove={(event) => showPreview(event, grenade)}
                  onPointerLeave={() => setPreview(null)}
                  onClick={() => onGrenadeOpen?.(grenade.id)}
                  onContextMenu={(event) =>
                    showCoordinateMenu(event, [grenade])
                  }
                  aria-label={tr(
                    `${grenadeLabel(grenade.grenade_type)} grenade #${grenade.id}. Open details. Right-click to copy coordinates.`,
                    `${grenadeLabel(grenade.grenade_type)} граната #${grenade.id}. Открыть детали. ПКМ для копирования координат.`,
                  )}
                >
                  {grenade.id === copiedGrenadeId ? (
                    <Check size={13} />
                  ) : (
                    markerIcon(grenade.grenade_type)
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {activeGroup ? (
          <div
            className="throw-strip"
            data-map-control="1"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setActiveGroupId(null);
                setPreview(null);
              }
            }}
            onWheel={(event) => {
              event.preventDefault();
              event.currentTarget.scrollTop += event.deltaY;
            }}
          >
            {activeGroup.grenades.map((grenade) => (
              <button
                key={grenade.id}
                className={`throw-strip-dot ${grenade.is_core ? 'core' : ''} ${grenade.id === copiedGrenadeId ? 'coordinates-copied' : ''}`}
                style={
                  {
                    '--dot': typeColor[grenade.grenade_type] ?? '#fff',
                  } as CSSProperties
                }
                onClick={() => onGrenadeOpen?.(grenade.id)}
                onPointerEnter={(event) => showPreview(event, grenade)}
                onPointerLeave={() => setPreview(null)}
                onContextMenu={(event) => showCoordinateMenu(event, [grenade])}
                aria-label={tr(
                  `${grenadeLabel(grenade.grenade_type)} grenade #${grenade.id}. Open details.`,
                  `${grenadeLabel(grenade.grenade_type)} граната #${grenade.id}. Открыть детали.`,
                )}
              >
                {grenade.id === copiedGrenadeId ? (
                  <Check size={13} />
                ) : (
                  markerIcon(grenade.grenade_type)
                )}
              </button>
            ))}
            <button
              className="throw-strip-close"
              type="button"
              onClick={() => {
                setActiveGroupId(null);
                setPreview(null);
              }}
              aria-label={tr('Close throw cluster', 'Закрыть кластер броска')}
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
        {preview ? (
          <div
            className="throw-preview-popover"
            style={previewStyle}
            data-map-control="1"
          >
            <div className="throw-preview-head">
              <span className="throw-preview-mark" />
              <strong>
                #{preview.grenade.id}{' '}
                {grenadeLabel(preview.grenade.grenade_type)}
              </strong>
              <span>{preview.grenade.side}</span>
              {isInstaGrenade(preview.grenade, spawnMapPoints) ? (
                <em className="insta">{INSTA_LABEL}</em>
              ) : null}
              {preview.grenade.is_core ? (
                <em>{tr('Core', 'Избранное')}</em>
              ) : null}
            </div>
            {previewKeys.length ? (
              <div className="throw-preview-keys">
                {previewKeys.map((key, index) => {
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
                      {index < previewKeys.length - 1 ? (
                        <span className="throw-preview-plus">+</span>
                      ) : null}
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="throw-preview-empty">
                {tr('No throw keys', 'Нет клавиш броска')}
              </div>
            )}
            <div className="throw-preview-info">
              <span className="throw-preview-thrower">
                {preview.grenade.thrower ||
                  tr('Parsed throw', 'Распознанный бросок')}
              </span>
              {preview.grenade.thrower_team ? (
                <span
                  className={`throw-preview-team side-accent-${preview.grenade.side.toLowerCase()}`}
                >
                  {preview.grenade.thrower_team}
                </span>
              ) : null}
              <span>
                {tr('Airtime', 'Время полета')}:{' '}
                <strong>
                  {typeof preview.grenade.airtime === 'number'
                    ? `${preview.grenade.airtime.toFixed(2)}s`
                    : '-'}
                </strong>
              </span>
              <span>
                {tr('Usage', 'Использований')}:{' '}
                <strong>{formatNumber(preview.grenade.usage_count)}</strong>
              </span>
            </div>
            {previewCommands.length ? (
              <div className="throw-preview-command">
                {previewCommands.map((command) => (
                  <span key={command}>{command}</span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {coordinateMenu ? (
          <div
            className="coordinate-copy-menu"
            style={{
              left: clamp(
                coordinateMenu.x,
                12,
                Math.max(12, (viewportRef.current?.clientWidth ?? 0) - 268),
              ),
              top: clamp(
                coordinateMenu.y,
                12,
                Math.max(12, (viewportRef.current?.clientHeight ?? 0) - 160),
              ),
            }}
            data-map-control="1"
          >
            <strong>{tr('Copy coordinates', 'Копировать координаты')}</strong>
            {coordinateMenu.grenades.map((grenade) => (
              <button
                key={grenade.id}
                type="button"
                onClick={() => {
                  copyGrenadeCoordinates(grenade);
                  setCoordinateMenu(null);
                }}
              >
                <span>
                  {grenadeLabel(grenade.grenade_type)} #{grenade.id}
                </span>
                <small>
                  {grenade.thrower || tr('Parsed throw', 'Распознанный бросок')}
                </small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
