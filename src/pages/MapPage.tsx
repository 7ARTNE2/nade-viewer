import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Filter,
  PanelRightClose,
  PanelRightOpen,
  LocateFixed,
  Map,
  RotateCcw,
  Search,
  Send,
  Shapes,
} from 'lucide-react';
import MapCanvas, { type IconTheme } from '../components/MapCanvas';
import GrenadeList from '../components/GrenadeList';
import {
  getMaps,
  getClusterGrenades,
  getMapOverview,
  getSiteSettings,
  getSpawnPoints,
  getThrowClusterGrenades,
  getThrowOverview,
  setGrenadeCore,
  updateSiteSettings,
} from '../lib/tauri';
import { formatNumber, grenadeLabel } from '../lib/format';
import type {
  GrenadePreview,
  LandingCluster,
  MapFilters,
  MapOverview,
  MapSummary,
  SpawnPoint,
} from '../types/domain';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';
import {
  defaultMapFilters,
  filtersMatchDefault,
  mapViewStorageKey,
  radarLevels,
  readStoredMapViewState,
  writeStoredMapViewState,
  type GrenadeMode,
  type RadarMode,
  type StoredMapViewState,
} from './mapViewPersistence';

const grenadeTypes = ['all', 'smoke', 'flash', 'molotov', 'HE'];
const sides = ['Any', 'T', 'CT'];
const clusterAccentRgb: Record<string, string> = {
  T: '249, 115, 22',
  CT: '96, 165, 250',
  MIX: '167, 139, 250',
  NEUTRAL: '226, 232, 240',
};
const clusterPageSize = 12;
const grenadePageSize = 30;

type MapPageProps = {
  activeImportId: number;
};

export default function MapPage({ activeImportId }: MapPageProps) {
  const { locale, tr, count } = useI18n();
  const { showToast } = useToast();
  const { mapName = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const decodedMap = useMemo(() => {
    try {
      return decodeURIComponent(mapName);
    } catch {
      return mapName;
    }
  }, [mapName]);
  const stateStorageKey = useMemo(
    () => mapViewStorageKey(activeImportId, decodedMap),
    [activeImportId, decodedMap],
  );
  const initialViewStateRef = useRef<StoredMapViewState | null | undefined>(
    undefined,
  );
  if (initialViewStateRef.current === undefined) {
    initialViewStateRef.current = readStoredMapViewState(stateStorageKey);
  }
  const initialViewState = initialViewStateRef.current;
  const navigationSearch =
    typeof (location.state as { search?: unknown } | null)?.search === 'string'
      ? (location.state as { search: string }).search.trim()
      : '';
  const hasNavigationSearch = navigationSearch.length > 0;
  const [filters, setFilters] = useState<MapFilters>(() => ({
    ...(initialViewState?.filters ?? defaultMapFilters()),
    ...(hasNavigationSearch ? { search: navigationSearch } : {}),
  }));
  const [overview, setOverview] = useState<MapOverview | null>(null);
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [mapSelectorOpen, setMapSelectorOpen] = useState(false);
  const [spawns, setSpawns] = useState<SpawnPoint[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<LandingCluster | null>(
    null,
  );
  const [grenades, setGrenades] = useState<GrenadePreview[]>([]);
  const [mapGrenades, setMapGrenades] = useState<GrenadePreview[]>([]);
  const [clusterPage, setClusterPage] = useState(
    hasNavigationSearch ? 0 : (initialViewState?.clusterPage ?? 0),
  );
  const [grenadePage, setGrenadePage] = useState(
    hasNavigationSearch ? 0 : (initialViewState?.grenadePage ?? 0),
  );
  const [grenadeLoading, setGrenadeLoading] = useState(false);
  const [showSpawns, setShowSpawns] = useState(
    initialViewState?.showSpawns ?? true,
  );
  const [loading, setLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [grenadeError, setGrenadeError] = useState<string | null>(null);
  const [overviewRetry, setOverviewRetry] = useState(0);
  const [radarMode, setRadarMode] = useState<RadarMode>(
    initialViewState?.radarMode ?? 'default',
  );
  const [grenadeMode, setGrenadeMode] = useState<GrenadeMode>(
    initialViewState?.grenadeMode ?? 'landing',
  );
  const [iconTheme, setIconTheme] = useState<IconTheme>(
    initialViewState?.iconTheme ?? 'base',
  );
  const [siteMinUsage, setSiteMinUsage] = useState(1);
  const [pendingSiteMinUsage, setPendingSiteMinUsage] = useState<number | null>(
    null,
  );
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [visibilityRulesOpen, setVisibilityRulesOpen] = useState(false);
  const overviewRequestRef = useRef(0);
  const clusterRequestRef = useRef(0);
  const mapTrajectoriesRequestRef = useRef(0);
  const restoredClusterIdRef = useRef<string | null>(
    hasNavigationSearch ? null : (initialViewState?.selectedClusterId ?? null),
  );
  const restoredGrenadePageRef = useRef(
    hasNavigationSearch ? 0 : (initialViewState?.grenadePage ?? 0),
  );
  const previousStorageKeyRef = useRef(stateStorageKey);
  const previousImportIdRef = useRef(activeImportId);
  const skipNextStatePersistenceRef = useRef(false);
  const mapSelectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSiteSettings()
      .then((settings) => setSiteMinUsage(settings.public_min_usage_count))
      .catch(() => setSiteMinUsage(1));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMaps()
      .then((nextMaps) => {
        if (!cancelled) setMaps(Array.isArray(nextMaps) ? nextMaps : []);
      })
      .catch(() => {
        if (!cancelled) setMaps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeImportId]);

  useEffect(() => {
    if (!mapSelectorOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!mapSelectorRef.current?.contains(event.target as Node))
        setMapSelectorOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMapSelectorOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mapSelectorOpen]);

  useEffect(() => {
    if (previousStorageKeyRef.current === stateStorageKey) return;
    previousStorageKeyRef.current = stateStorageKey;
    const isImportSwitch = previousImportIdRef.current !== activeImportId;
    previousImportIdRef.current = activeImportId;
    const nextViewState = readStoredMapViewState(stateStorageKey);
    skipNextStatePersistenceRef.current = true;
    restoredClusterIdRef.current = isImportSwitch
      ? (selectedCluster?.id ?? null)
      : (nextViewState?.selectedClusterId ?? null);
    restoredGrenadePageRef.current = isImportSwitch
      ? grenadePage
      : (nextViewState?.grenadePage ?? 0);
    if (!isImportSwitch)
      setFilters(nextViewState?.filters ?? defaultMapFilters());
    setSelectedCluster(null);
    setGrenades([]);
    setMapGrenades([]);
    setClusterPage(
      isImportSwitch ? clusterPage : (nextViewState?.clusterPage ?? 0),
    );
    setGrenadePage(
      isImportSwitch ? grenadePage : (nextViewState?.grenadePage ?? 0),
    );
    if (!isImportSwitch) {
      setShowSpawns(nextViewState?.showSpawns ?? true);
      setRadarMode(nextViewState?.radarMode ?? 'default');
      setGrenadeMode(nextViewState?.grenadeMode ?? 'landing');
      setIconTheme(nextViewState?.iconTheme ?? 'base');
    }
    clusterRequestRef.current += 1;
    mapTrajectoriesRequestRef.current += 1;
  }, [
    activeImportId,
    clusterPage,
    grenadePage,
    selectedCluster,
    stateStorageKey,
  ]);

  useEffect(() => {
    if (skipNextStatePersistenceRef.current) {
      skipNextStatePersistenceRef.current = false;
      return;
    }
    if (selectedCluster) {
      restoredClusterIdRef.current = selectedCluster.id;
      restoredGrenadePageRef.current = grenadePage;
    }
    writeStoredMapViewState(stateStorageKey, {
      filters,
      selectedClusterId: selectedCluster?.id ?? restoredClusterIdRef.current,
      clusterPage,
      grenadePage: selectedCluster
        ? grenadePage
        : restoredGrenadePageRef.current,
      showSpawns,
      radarMode,
      grenadeMode,
      iconTheme,
    });
  }, [
    clusterPage,
    filters,
    grenadePage,
    grenadeMode,
    iconTheme,
    radarMode,
    selectedCluster,
    showSpawns,
    stateStorageKey,
  ]);

  useEffect(() => {
    const requestId = overviewRequestRef.current + 1;
    overviewRequestRef.current = requestId;
    const requestFilters: MapFilters = { ...filters, radar_level: radarMode };
    setLoading(true);
    setOverviewError(null);
    setGrenadeError(null);
    setOverview(null);
    setSpawns([]);
    setSelectedCluster(null);
    setGrenades([]);
    setMapGrenades([]);
    setClusterPage(0);
    setGrenadePage(0);
    clusterRequestRef.current += 1;
    mapTrajectoriesRequestRef.current += 1;
    const overviewLoader =
      grenadeMode === 'throw' ? getThrowOverview : getMapOverview;
    Promise.all([
      overviewLoader(decodedMap, requestFilters),
      getSpawnPoints(decodedMap, 'Any'),
    ])
      .then(([nextOverview, nextSpawns]) => {
        if (overviewRequestRef.current === requestId) {
          setOverview(nextOverview);
          setSpawns(nextSpawns);
          const restoreClusterId = restoredClusterIdRef.current;
          if (restoreClusterId) {
            const restoredCluster =
              nextOverview.clusters.find(
                (cluster) => cluster.id === restoreClusterId,
              ) ?? null;
            if (restoredCluster) {
              setSelectedCluster(restoredCluster);
              Promise.all([
                loadClusterGrenades(
                  restoredCluster,
                  restoredGrenadePageRef.current,
                ),
                loadClusterMapGrenades(restoredCluster),
              ]).catch((error) => {
                console.error(error);
                setGrenadeError(
                  tr('Unable to load grenades', 'Не удалось загрузить гранаты'),
                );
              });
            } else {
              restoredClusterIdRef.current = null;
              restoredGrenadePageRef.current = 0;
              setGrenadePage(0);
            }
          }
        }
      })
      .catch((error) => {
        if (overviewRequestRef.current === requestId) {
          console.error(error);
          setOverviewError(
            tr(
              'Unable to load map overview',
              'Не удалось загрузить обзор карты',
            ),
          );
        }
      })
      .finally(() => {
        if (overviewRequestRef.current === requestId) {
          setLoading(false);
        }
      });
  }, [
    activeImportId,
    decodedMap,
    filters,
    grenadeMode,
    locale,
    overviewRetry,
    radarMode,
    siteMinUsage,
  ]);

  useEffect(() => {
    if (!overview || overview.map.has_lower_radar || radarMode === 'default')
      return;
    setRadarMode('default');
  }, [overview, radarMode]);

  const loadClusterGrenades = async (cluster: LandingCluster, page: number) => {
    const requestId = clusterRequestRef.current + 1;
    clusterRequestRef.current = requestId;
    setGrenadeLoading(true);
    setGrenadeError(null);

    try {
      const clusterLoader =
        grenadeMode === 'throw' ? getThrowClusterGrenades : getClusterGrenades;
      const nextGrenades = await clusterLoader(
        decodedMap,
        cluster.id,
        { ...filters, radar_level: radarMode },
        grenadePageSize,
        page * grenadePageSize,
      );
      if (clusterRequestRef.current === requestId) {
        setGrenades(nextGrenades);
        setGrenadePage(page);
        restoredGrenadePageRef.current = page;
      }
    } catch (error) {
      if (clusterRequestRef.current === requestId) {
        console.error(error);
        setGrenadeError(
          tr('Unable to load grenades', 'Не удалось загрузить гранаты'),
        );
      }
    } finally {
      if (clusterRequestRef.current === requestId) {
        setGrenadeLoading(false);
      }
    }
  };

  const loadClusterMapGrenades = async (cluster: LandingCluster) => {
    const requestId = mapTrajectoriesRequestRef.current + 1;
    mapTrajectoriesRequestRef.current = requestId;
    const clusterLoader =
      grenadeMode === 'throw' ? getThrowClusterGrenades : getClusterGrenades;
    const nextGrenades = await clusterLoader(
      decodedMap,
      cluster.id,
      { ...filters, radar_level: radarMode },
      0,
      0,
    );
    if (mapTrajectoriesRequestRef.current === requestId) {
      setMapGrenades(nextGrenades);
    }
  };

  const selectCluster = async (cluster: LandingCluster) => {
    if (selectedCluster?.id === cluster.id) {
      restoredClusterIdRef.current = null;
      restoredGrenadePageRef.current = 0;
      setSelectedCluster(null);
      setGrenades([]);
      setMapGrenades([]);
      setGrenadePage(0);
      mapTrajectoriesRequestRef.current += 1;
      return;
    }

    restoredClusterIdRef.current = cluster.id;
    restoredGrenadePageRef.current = 0;
    setSelectedCluster(cluster);
    setGrenades([]);
    setMapGrenades([]);
    setGrenadeError(null);
    try {
      await Promise.all([
        loadClusterGrenades(cluster, 0),
        loadClusterMapGrenades(cluster),
      ]);
    } catch (error) {
      console.error(error);
      setGrenadeError(
        tr('Unable to load grenades', 'Не удалось загрузить гранаты'),
      );
      setGrenades([]);
      setMapGrenades([]);
    }
  };

  const clusters = overview?.clusters ?? [];
  const clusterPageCount = Math.max(
    1,
    Math.ceil(clusters.length / clusterPageSize),
  );
  const visibleClusters = useMemo(
    () =>
      clusters.slice(
        clusterPage * clusterPageSize,
        (clusterPage + 1) * clusterPageSize,
      ),
    [clusters, clusterPage],
  );
  const grenadePageCount = selectedCluster
    ? Math.max(1, Math.ceil(selectedCluster.count / grenadePageSize))
    : 1;
  const grenadeStart = selectedCluster ? grenadePage * grenadePageSize + 1 : 0;
  const grenadeEnd = selectedCluster
    ? Math.min(
        selectedCluster.count,
        grenadePage * grenadePageSize + grenades.length,
      )
    : 0;
  const hasLowerRadar = overview?.map.has_lower_radar === true;
  const mapImagePath =
    hasLowerRadar && radarMode === 'lower' && overview?.map.lower_map_image_path
      ? overview.map.lower_map_image_path
      : overview?.map.map_image_path;
  const visibleSpawns = useMemo(() => {
    const split = overview?.map.radar_split_z;
    if (!hasLowerRadar || typeof split !== 'number') return spawns;
    return spawns.filter((spawn) =>
      radarMode === 'lower' ? spawn.pos_z <= split : spawn.pos_z > split,
    );
  }, [hasLowerRadar, overview?.map.radar_split_z, radarMode, spawns]);
  const filtersAreDefault = useMemo(
    () => filtersMatchDefault(filters),
    [filters],
  );
  const canResetFilters =
    !filtersAreDefault ||
    selectedCluster !== null ||
    clusterPage !== 0 ||
    grenadePage !== 0;
  const siteValue = pendingSiteMinUsage ?? siteMinUsage;
  const siteProgress = ((siteValue - 1) / 49) * 100;
  const activeFilterCount = [
    filters.grenade_type !== 'all',
    filters.side !== 'Any',
    Boolean(filters.search?.trim()),
    Boolean(filters.thrower_team?.trim()),
    filters.is_core,
  ].filter(Boolean).length;
  const filterSummary = activeFilterCount
    ? count(
        activeFilterCount,
        'active filter',
        'active filters',
        'активный фильтр',
        'активных фильтра',
        'активных фильтров',
      )
    : tr('All grenades', 'Все гранаты');
  const currentMap = maps.find((map) => map.name === decodedMap);
  const displayedMap = currentMap ?? overview?.map;
  const selectableMaps = maps.filter(
    (map) => map.grenade_count > 0 || map.name === decodedMap,
  );

  const switchGrenadeMode = (mode: GrenadeMode) => {
    if (grenadeMode === mode) return;
    restoredClusterIdRef.current = null;
    restoredGrenadePageRef.current = 0;
    setSelectedCluster(null);
    setGrenades([]);
    setMapGrenades([]);
    setGrenadePage(0);
    clusterRequestRef.current += 1;
    mapTrajectoriesRequestRef.current += 1;
    setGrenadeMode(mode);
  };

  const resetFilters = () => {
    if (!canResetFilters) return;
    restoredClusterIdRef.current = null;
    restoredGrenadePageRef.current = 0;
    setSelectedCluster(null);
    setGrenades([]);
    setMapGrenades([]);
    setClusterPage(0);
    setGrenadePage(0);
    clusterRequestRef.current += 1;
    mapTrajectoriesRequestRef.current += 1;
    setFilters(defaultMapFilters());
  };

  const applySiteSettings = async () => {
    if (pendingSiteMinUsage === null || pendingSiteMinUsage === siteMinUsage)
      return;
    const next = await updateSiteSettings(pendingSiteMinUsage);
    setSiteMinUsage(next.public_min_usage_count);
    setPendingSiteMinUsage(null);
    restoredClusterIdRef.current = null;
    restoredGrenadePageRef.current = 0;
    setSelectedCluster(null);
    setGrenades([]);
    setMapGrenades([]);
    setGrenadePage(0);
    mapTrajectoriesRequestRef.current += 1;
  };

  const handleCoreToggle = async (id: number, isCore: boolean) => {
    const requestId = overviewRequestRef.current + 1;
    overviewRequestRef.current = requestId;
    const previousGrenades = grenades;
    const previousMapGrenades = mapGrenades;
    setGrenades((list) =>
      filters.is_core && !isCore
        ? list.filter((grenade) => grenade.id !== id)
        : list.map((grenade) =>
            grenade.id === id ? { ...grenade, is_core: isCore } : grenade,
          ),
    );
    setMapGrenades((list) =>
      filters.is_core && !isCore
        ? list.filter((grenade) => grenade.id !== id)
        : list.map((grenade) =>
            grenade.id === id ? { ...grenade, is_core: isCore } : grenade,
          ),
    );

    try {
      await setGrenadeCore(id, isCore);
      const overviewLoader =
        grenadeMode === 'throw' ? getThrowOverview : getMapOverview;
      const nextOverview = await overviewLoader(decodedMap, {
        ...filters,
        radar_level: radarMode,
      });
      if (overviewRequestRef.current === requestId) {
        setOverview(nextOverview);
      }
      showToast(
        isCore
          ? tr('Added to Core', 'Добавлено в избранное')
          : tr('Removed from Core', 'Удалено из избранного'),
        { tone: 'success' },
      );
    } catch (error) {
      console.error(error);
      if (overviewRequestRef.current === requestId) {
        setGrenades(previousGrenades);
        setMapGrenades(previousMapGrenades);
      }
      showToast(tr('Could not update Core', 'Не удалось обновить избранное'), {
        tone: 'error',
      });
    }
  };

  const retryClusterLoad = (cluster: LandingCluster) => {
    setGrenadeError(null);
    Promise.all([
      loadClusterGrenades(cluster, grenadePage),
      loadClusterMapGrenades(cluster),
    ]).catch((error) => {
      console.error(error);
      setGrenadeError(
        tr('Unable to load grenades', 'Не удалось загрузить гранаты'),
      );
    });
  };

  return (
    <div
      className={`map-workspace ${inspectorVisible ? '' : 'inspector-hidden'}`}
    >
      <section className="map-main-panel">
        <div
          className={`map-toolbar ${hasLowerRadar ? 'has-radar-switch' : ''}`}
          data-tour="map-workspace-toolbar"
        >
          <button
            className="icon-btn"
            onClick={() => navigate('/maps')}
            aria-label={tr('Back to maps', 'К картам')}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="map-heading">
            <div className="map-selector" ref={mapSelectorRef}>
              <button
                className="map-selector-trigger"
                type="button"
                onClick={() => setMapSelectorOpen((open) => !open)}
                aria-expanded={mapSelectorOpen}
                aria-haspopup="listbox"
                aria-label={tr('Select map', 'Выбрать карту')}
              >
                <Map size={15} aria-hidden="true" />
                <span className="map-selector-current">
                  <strong>{displayedMap?.label ?? decodedMap}</strong>
                  <span className="map-selector-filtered-count">
                    <small>
                      {loading
                        ? tr('Loading', 'Загрузка')
                        : tr('Filtered grenades', 'Гранат по фильтру')}
                    </small>
                    {!loading ? (
                      <b>{formatNumber(overview?.grenade_count ?? 0)}</b>
                    ) : null}
                  </span>
                </span>
                <ChevronDown
                  className={mapSelectorOpen ? 'open' : ''}
                  size={15}
                  aria-hidden="true"
                />
              </button>
              {mapSelectorOpen ? (
                <div
                  className="map-selector-menu"
                  role="listbox"
                  aria-label={tr('Available maps', 'Доступные карты')}
                >
                  <div className="map-selector-menu-label">
                    {tr('Switch map', 'Сменить карту')}
                  </div>
                  {selectableMaps.map((map) => {
                    const active = map.name === decodedMap;
                    return (
                      <button
                        key={map.name}
                        className={active ? 'active' : ''}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          setMapSelectorOpen(false);
                          if (!active)
                            navigate(`/map/${encodeURIComponent(map.name)}`);
                        }}
                      >
                        <span className="map-selector-option-copy">
                          <strong>{map.label}</strong>
                        </span>
                        <span className="map-selector-option-count">
                          <strong>{formatNumber(map.grenade_count)}</strong>
                          <small>{tr('lineups', 'раскидок')}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
          <div className="toolbar-spacer" />
          <button
            className="toggle inspector-toggle"
            type="button"
            onClick={() => setInspectorVisible((visible) => !visible)}
            data-tip={
              inspectorVisible
                ? tr('Focus on map', 'Сфокусироваться на карте')
                : tr('Show workspace panel', 'Показать рабочую панель')
            }
            aria-label={
              inspectorVisible
                ? tr('Focus on map', 'Сфокусироваться на карте')
                : tr('Show workspace panel', 'Показать рабочую панель')
            }
          >
            {inspectorVisible ? (
              <PanelRightClose size={15} />
            ) : (
              <PanelRightOpen size={15} />
            )}
            {inspectorVisible ? tr('Focus', 'Фокус') : tr('Panel', 'Панель')}
          </button>
          <button
            className={`toggle map-appearance-toggle ${iconTheme === 'asset' ? 'active' : ''}`}
            onClick={() =>
              setIconTheme((theme) => (theme === 'base' ? 'asset' : 'base'))
            }
            data-tip={tr(
              'Toggle grenade point icons',
              'Переключить значки точек',
            )}
            aria-label={tr(
              'Toggle grenade point icons',
              'Переключить значки точек',
            )}
          >
            <Shapes size={15} />
            {tr('Icons', 'Значки')}
          </button>
          <button
            aria-pressed={filters.is_core}
            className={`toggle core-toolbar-toggle ${filters.is_core ? 'active' : ''}`}
            onClick={() =>
              setFilters((state) => ({ ...state, is_core: !state.is_core }))
            }
            data-tip={tr(
              'Toggle core grenades',
              'Переключить избранные гранаты',
            )}
            aria-label={tr(
              'Toggle core grenades',
              'Переключить избранные гранаты',
            )}
          >
            <BadgeCheck size={15} />
            {tr('Core', 'Избранные')}
          </button>
          <button
            aria-pressed={showSpawns}
            className={`toggle spawns-toolbar-toggle ${showSpawns ? 'active' : ''}`}
            onClick={() => setShowSpawns((value) => !value)}
            data-tip={tr('Toggle spawn points', 'Переключить точки спавнов')}
            aria-label={tr('Toggle spawn points', 'Переключить точки спавнов')}
          >
            <LocateFixed size={15} />
            {tr('Spawns', 'Спавны')}
          </button>
          <button
            aria-pressed={grenadeMode === 'throw'}
            className={`toggle throw-toolbar-toggle ${grenadeMode === 'throw' ? 'active' : ''}`}
            onClick={() =>
              switchGrenadeMode(grenadeMode === 'throw' ? 'landing' : 'throw')
            }
            data-tip={tr(
              'Group by throw position',
              'Группировать по позиции броска',
            )}
          >
            <Send size={15} />
            {tr('Throw', 'Бросок')}
          </button>
          {hasLowerRadar ? (
            <div
              className="radar-switch"
              aria-label={tr('Radar level', 'Уровень радара')}
            >
              {radarLevels.map((level) => (
                <button
                  key={level.key}
                  className={radarMode === level.key ? 'active' : ''}
                  aria-pressed={radarMode === level.key}
                  onClick={() => {
                    setRadarMode(level.key);
                    restoredClusterIdRef.current = null;
                    restoredGrenadePageRef.current = 0;
                    setSelectedCluster(null);
                    setGrenades([]);
                    setMapGrenades([]);
                    setGrenadePage(0);
                    mapTrajectoriesRequestRef.current += 1;
                  }}
                >
                  <span className="radar-switch-indicator" aria-hidden="true" />
                  {level.key === 'default'
                    ? tr('Main', 'Основной')
                    : tr('Lower', 'Нижний')}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {overviewError ? (
          <div className="detail-load-error">
            <strong>
              {tr('Unable to open map', 'Не удалось открыть карту')}
            </strong>
            <p>{overviewError}</p>
            <button
              className="btn primary"
              onClick={() => setOverviewRetry((value) => value + 1)}
            >
              {tr('Retry', 'Повторить')}
            </button>
          </div>
        ) : (
          <MapCanvas
            mapImagePath={mapImagePath}
            mapLabel={overview?.map.label ?? decodedMap}
            clusters={overview?.clusters}
            selectedClusterId={selectedCluster?.id}
            grenades={mapGrenades}
            grenadePointMode={grenadeMode === 'throw' ? 'landing' : 'throw'}
            spawnPoints={visibleSpawns}
            showSpawns={showSpawns}
            iconTheme={iconTheme}
            onClusterSelect={selectCluster}
            onGrenadeOpen={(id) => navigate(`/grenade/${id}`)}
          />
        )}
      </section>

      <aside className="inspector">
        <div
          className="panel-section compact-filter inspector-filter"
          data-tour="map-filters"
        >
          <div className="section-title">
            <span>
              <Filter size={15} />
              {tr('Filters', 'Фильтры')}
            </span>
            <button
              className="micro-btn filter-reset-btn"
              type="button"
              onClick={resetFilters}
              disabled={!canResetFilters}
              data-tip={tr('Reset filters', 'Сбросить фильтры')}
            >
              <RotateCcw size={13} />
              {tr('Reset', 'Сбросить')}
            </button>
          </div>
          <div
            className={`filter-summary ${activeFilterCount ? 'active' : ''}`}
          >
            <span>{filterSummary}</span>
            {filters.search?.trim() || filters.thrower_team?.trim() ? (
              <span className="filter-summary-queries">
                {filters.search?.trim() ? (
                  <span className="filter-summary-query">
                    &quot;{filters.search.trim()}&quot;
                  </span>
                ) : null}
                {filters.thrower_team?.trim() ? (
                  <span className="filter-summary-query">
                    {tr('Team', 'Команда')}: &quot;{filters.thrower_team.trim()}
                    &quot;
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="segmented">
            {grenadeTypes.map((type) => (
              <button
                key={type}
                className={`filter-btn filter-${String(type).toLowerCase()} ${filters.grenade_type === type ? 'active' : ''}`}
                aria-label={
                  type === 'molotov'
                    ? tr('Molotov and Incendiary', 'Молотов и Зажигательная')
                    : undefined
                }
                onClick={() =>
                  setFilters((state) => ({ ...state, grenade_type: type }))
                }
              >
                {type === 'all' ? (
                  tr('All', 'Все')
                ) : type === 'molotov' ? (
                  <>
                    <span className="filter-label-molotov">
                      {tr('Molotov', 'Молотов')}
                    </span>
                    /
                    <span className="filter-label-incendiary">
                      {tr('Incendiary', 'Зажигательная')}
                    </span>
                  </>
                ) : type === 'smoke' ? (
                  tr('Smoke', 'Дым')
                ) : type === 'flash' ? (
                  tr('Flash', 'Флеш')
                ) : type === 'HE' ? (
                  <span className="filter-label-he">
                    {tr('HE', 'Осколочная')}
                  </span>
                ) : (
                  grenadeLabel(type)
                )}
              </button>
            ))}
          </div>
          <div className="segmented three">
            {sides.map((side) => (
              <button
                key={side}
                className={`filter-btn side-${side.toLowerCase()} ${filters.side === side ? 'active' : ''}`}
                onClick={() => setFilters((state) => ({ ...state, side }))}
              >
                {side === 'Any'
                  ? tr('Any', 'Все')
                  : side === 'T'
                    ? tr('T', 'Т')
                    : tr('CT', 'КТ')}
              </button>
            ))}
          </div>
          <label className="mini-field filter-search-visible">
            <Search size={14} />
            <input
              value={filters.search ?? ''}
              onChange={(event) =>
                setFilters((state) => ({
                  ...state,
                  search: event.target.value,
                }))
              }
              placeholder={tr(
                'Thrower, demo name, coordinates',
                'Игрок, имя демо, координаты',
              )}
              aria-label={tr('Search grenades', 'Найти гранату')}
            />
          </label>
          <label className="secondary-filter-field">
            <span>{tr('Narrow by team', 'Уточнить по команде')}</span>
            <span className="mini-field team-search-field">
              <Search size={14} />
              <input
                value={filters.thrower_team ?? ''}
                onChange={(event) =>
                  setFilters((state) => ({
                    ...state,
                    thrower_team: event.target.value,
                  }))
                }
                placeholder={tr('Thrower team', 'Команда игрока')}
                aria-label={tr(
                  'Search by thrower team',
                  'Поиск по команде игрока',
                )}
              />
            </span>
          </label>
        </div>

        <div className="panel-section inspector-visibility">
          <button
            className="section-title section-toggle"
            type="button"
            onClick={() => setVisibilityRulesOpen((open) => !open)}
            aria-expanded={visibilityRulesOpen}
          >
            <span>{tr('Visibility rules', 'Правила видимости')}</span>
            <span className="section-toggle-meta">
              {tr(`Min. ${siteValue}`, `Мин. ${siteValue}`)}
              {visibilityRulesOpen ? (
                <ChevronUp size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </span>
          </button>
          {visibilityRulesOpen ? (
            <div className="setting-card">
              <div className="setting-row">
                <span>{tr('Public min usage', 'Минимум использований')}</span>
                <strong>{siteValue}</strong>
              </div>
              <input
                className="range"
                type="range"
                min="1"
                max="50"
                step="1"
                value={siteValue}
                onChange={(event) =>
                  setPendingSiteMinUsage(Number(event.target.value))
                }
                style={
                  {
                    '--range-progress': `${siteProgress}%`,
                  } as React.CSSProperties
                }
              />
              {pendingSiteMinUsage !== null &&
              pendingSiteMinUsage !== siteMinUsage ? (
                <div className="setting-actions">
                  <button
                    onClick={() => applySiteSettings().catch(console.error)}
                  >
                    {tr('Apply', 'Применить')}
                  </button>
                  <button onClick={() => setPendingSiteMinUsage(null)}>
                    {tr('Cancel', 'Отмена')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className="panel-section cluster-panel inspector-clusters"
          data-tour="cluster-list"
        >
          <div className="section-title">
            {grenadeMode === 'throw'
              ? tr('Throw clusters', 'Кластеры бросков')
              : tr('Landing clusters', 'Кластеры приземления')}
            <span className="section-count">
              {clusters.length ? `${clusterPage + 1}/${clusterPageCount}` : '0'}
            </span>
          </div>
          <div className="cluster-list">
            {visibleClusters.map((cluster) => (
              <button
                key={cluster.id}
                className={selectedCluster?.id === cluster.id ? 'selected' : ''}
                style={
                  {
                    '--cluster-rgb':
                      clusterAccentRgb[cluster.side_key] ??
                      clusterAccentRgb.NEUTRAL,
                  } as React.CSSProperties
                }
                onClick={() => selectCluster(cluster).catch(console.error)}
              >
                <span
                  className={`cluster-side ${cluster.side_key.toLowerCase()}`}
                >
                  {cluster.side_key}
                </span>
                <strong>{cluster.count}</strong>
                <small>
                  {cluster.unique_types.map(grenadeLabel).join(', ')}
                </small>
              </button>
            ))}
          </div>
          {clusterPageCount > 1 ? (
            <div className="panel-pager">
              <button
                onClick={() => setClusterPage((page) => Math.max(0, page - 1))}
                disabled={clusterPage === 0}
                aria-label={tr(
                  'Previous landing clusters',
                  'Предыдущие кластеры приземления',
                )}
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                {clusterPage * clusterPageSize + 1}-
                {Math.min(clusters.length, (clusterPage + 1) * clusterPageSize)}{' '}
                {tr('of', 'из')} {formatNumber(clusters.length)}
              </span>
              <button
                onClick={() =>
                  setClusterPage((page) =>
                    Math.min(clusterPageCount - 1, page + 1),
                  )
                }
                disabled={clusterPage >= clusterPageCount - 1}
                aria-label={tr(
                  'Next landing clusters',
                  'Следующие кластеры приземления',
                )}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
        </div>

        <div
          className={`panel-section grenade-panel inspector-grenades ${selectedCluster ? 'has-selection' : ''}`}
        >
          <div className="section-title">
            <span>
              {selectedCluster
                ? tr('Cluster lineups', 'Раскидки кластера')
                : tr('Selected grenades', 'Выбранные гранаты')}
            </span>
            {selectedCluster ? (
              <span className="section-count">
                {formatNumber(selectedCluster.count)}
              </span>
            ) : null}
          </div>
          {selectedCluster ? (
            <div className="selected-cluster-context">
              <span
                className={`cluster-side ${selectedCluster.side_key.toLowerCase()}`}
              >
                {selectedCluster.side_key}
              </span>
              <span>
                <strong>
                  {count(
                    selectedCluster.count,
                    'lineup selected',
                    'lineups selected',
                    'раскидка выбрана',
                    'раскидки выбрано',
                    'раскидок выбрано',
                  )}
                </strong>
                <small>
                  {selectedCluster.unique_types.map(grenadeLabel).join(', ')}
                </small>
              </span>
            </div>
          ) : null}
          {grenadeError && selectedCluster ? (
            <div className="panel-load-error">
              <span>{grenadeError}</span>
              <button
                className="micro-btn"
                onClick={() => retryClusterLoad(selectedCluster)}
              >
                {tr('Retry', 'Повторить')}
              </button>
            </div>
          ) : (
            <GrenadeList
              grenades={grenades}
              compact
              showCopy
              loading={grenadeLoading}
              spawnPoints={visibleSpawns}
              onCoreToggle={handleCoreToggle}
              emptyLabel={
                filters.is_core
                  ? tr(
                      'No Core Nades in this cluster.',
                      'В этом кластере нет избранных гранат.',
                    )
                  : tr(
                      'Choose a cluster on the map or from the list to inspect its lineups.',
                      'Выберите кластер на карте или в списке, чтобы изучить его раскидки.',
                    )
              }
            />
          )}
          {selectedCluster && selectedCluster.count > grenadePageSize ? (
            <div className="panel-pager">
              <button
                onClick={() =>
                  loadClusterGrenades(
                    selectedCluster,
                    Math.max(0, grenadePage - 1),
                  )
                }
                disabled={grenadeLoading || grenadePage === 0}
                aria-label={tr(
                  'Previous selected grenades',
                  'Предыдущие выбранные гранаты',
                )}
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                {grenadeStart}-{grenadeEnd} {tr('of', 'из')}{' '}
                {formatNumber(selectedCluster.count)}
              </span>
              <button
                onClick={() =>
                  loadClusterGrenades(
                    selectedCluster,
                    Math.min(grenadePageCount - 1, grenadePage + 1),
                  )
                }
                disabled={grenadeLoading || grenadePage >= grenadePageCount - 1}
                aria-label={tr(
                  'Next selected grenades',
                  'Следующие выбранные гранаты',
                )}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
