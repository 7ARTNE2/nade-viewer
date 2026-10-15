import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Filter,
  PanelRightClose,
  PanelRightOpen,
  LocateFixed,
  Map,
  RotateCcw,
  Search,
  Send,
  Shapes,
  Trophy,
  UserRound,
  Users,
  X,
  Star,
} from 'lucide-react';
import MapCanvas, { type IconTheme } from '../components/MapCanvas';
import GrenadeList from '../components/GrenadeList';
import ThrowMotionIcon from '../components/ThrowMotionIcon';
import FilterSelect, {
  type FilterSelectOption,
} from '../components/FilterSelect';
import {
  getFavoriteFilterOptions,
  getFavoriteMapOverview,
  getFavoriteClusterGrenades,
  listFavorites,
  getImportPlayers,
  getImportTournaments,
  getMaps,
  getClusterGrenades,
  getMapOverview,
  getSiteSettings,
  getSpawnPoints,
  getThrowClusterGrenades,
  getThrowOverview,
  updateSiteSettings,
} from '../lib/tauri';
import { formatNumber, grenadeLabel } from '../lib/format';
import { reconcilePlayerSelections } from '../lib/mapFilterSelection';
import type {
  FavoriteFilters,
  GrenadePreview,
  ImportPlayerOption,
  ImportTeamOption,
  ImportTournamentOption,
  LandingCluster,
  MapFilters,
  MapOverview,
  MapSummary,
  SpawnPoint,
} from '../types/domain';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';
import { useFavorites } from '../lib/favorites';
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

type MapWorkspaceProps = {
  source:
    | { kind: 'import'; activeImportId: number }
    | {
        kind: 'favorites';
        mapName: string;
        collectionId?: number;
      };
  toolbar?: ReactNode;
  tutorialStep?: number | null;
};

export default function MapWorkspace({
  source,
  toolbar,
  tutorialStep,
}: MapWorkspaceProps) {
  const saved = source.kind === 'favorites';
  const defaultIconTheme: IconTheme = saved ? 'asset' : 'base';
  const activeImportId = source.kind === 'import' ? source.activeImportId : 0;
  const collectionId =
    source.kind === 'favorites' ? source.collectionId : undefined;
  const viewDefaults = () =>
    saved
      ? { ...defaultMapFilters(), grenade_type: 'all', side: 'Any' }
      : defaultMapFilters();
  const { locale, tr, count } = useI18n();
  const { showToast } = useToast();
  const {
    maps: favoriteMaps,
    revision: favoritesRevision,
    error: favoritesError,
    refresh: refreshFavorites,
  } = useFavorites();
  const { mapName: routeMapName = '' } = useParams();
  const mapName = source.kind === 'favorites' ? source.mapName : routeMapName;
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
    () =>
      saved
        ? `nadeviewer.favorites-map-view.${collectionId ?? 'all'}.${decodedMap}`
        : mapViewStorageKey(activeImportId, decodedMap),
    [saved, collectionId, activeImportId, decodedMap],
  );
  const initialViewStateRef = useRef<StoredMapViewState | null | undefined>(
    undefined,
  );
  if (initialViewStateRef.current === undefined) {
    initialViewStateRef.current = readStoredMapViewState(
      stateStorageKey,
      viewDefaults(),
      defaultIconTheme,
    );
  }
  const initialViewState = initialViewStateRef.current;
  const navigationSearch =
    typeof (location.state as { search?: unknown } | null)?.search === 'string'
      ? (location.state as { search: string }).search.trim()
      : '';
  const hasNavigationSearch = navigationSearch.length > 0;
  const [filters, setFilters] = useState<MapFilters>(() => ({
    ...(initialViewState?.filters ?? viewDefaults()),
    ...(hasNavigationSearch ? { search: navigationSearch } : {}),
  }));
  const [overview, setOverview] = useState<MapOverview | null>(null);
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [mapOptionsError, setMapOptionsError] = useState(false);
  const [players, setPlayers] = useState<ImportPlayerOption[]>([]);
  const [tournaments, setTournaments] = useState<ImportTournamentOption[]>([]);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [tournamentsLoading, setTournamentsLoading] = useState(false);
  const allPlayersCacheRef = useRef(
    new globalThis.Map<string, ImportPlayerOption[]>(),
  );
  const playerScopeKey = JSON.stringify([
    activeImportId,
    decodedMap,
    filters.tournament ?? [],
    collectionId,
  ]);
  const currentPlayerScopeRef = useRef(playerScopeKey);
  currentPlayerScopeRef.current = playerScopeKey;
  const [loadedPlayerScope, setLoadedPlayerScope] = useState<string | null>(
    null,
  );
  const playerOptionsAvailable = loadedPlayerScope === playerScopeKey;
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
    initialViewState?.iconTheme ?? defaultIconTheme,
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
    if (saved) return;
    getSiteSettings()
      .then((settings) => setSiteMinUsage(settings.public_min_usage_count))
      .catch(() => setSiteMinUsage(1));
  }, [saved]);

  useEffect(() => {
    let cancelled = false;
    setMapOptionsError(false);
    if (saved) return;
    getMaps()
      .then((nextMaps) => {
        if (!cancelled) setMaps(Array.isArray(nextMaps) ? nextMaps : []);
      })
      .catch(() => {
        if (!cancelled) {
          setMaps([]);
          setMapOptionsError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeImportId,
    saved,
    collectionId,
    saved ? favoritesRevision : 0,
    overviewRetry,
  ]);

  useEffect(() => {
    if (saved) setMaps(favoriteMaps);
  }, [saved, favoriteMaps]);

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
    let cancelled = false;
    const cacheKey = saved
      ? `favorites:${collectionId ?? 'all'}:${decodedMap}:${favoritesRevision}`
      : `${activeImportId}:${decodedMap}`;
    const cachedPlayers = allPlayersCacheRef.current.get(cacheKey);
    const acceptPlayers = (nextPlayers: ImportPlayerOption[]) => {
      if (cancelled || currentPlayerScopeRef.current !== playerScopeKey) return;
      const normalizedPlayers = Array.isArray(nextPlayers) ? nextPlayers : [];
      setPlayers(normalizedPlayers);
      setLoadedPlayerScope(playerScopeKey);
      setFilters((state) =>
        JSON.stringify([
          activeImportId,
          decodedMap,
          state.tournament ?? [],
          collectionId,
        ]) === playerScopeKey
          ? reconcilePlayerSelections(state, normalizedPlayers)
          : state,
      );
      if (!filters.tournament?.length)
        allPlayersCacheRef.current.set(cacheKey, normalizedPlayers);
    };
    if (!filters.tournament?.length && cachedPlayers) {
      acceptPlayers(cachedPlayers);
      setPlayersLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setPlayersLoading(true);
    setLoadedPlayerScope(null);
    (saved
      ? getFavoriteFilterOptions({
          map: decodedMap,
          collection_id: collectionId,
          tournament: filters.tournament,
        }).then((options) => options.players)
      : getImportPlayers(undefined, decodedMap, filters.tournament)
    )
      .then(acceptPlayers)
      .catch((error) => {
        console.error('Unable to load player filter options', error);
        if (!cancelled)
          showToast(
            tr(
              'Unable to load player filter options. Select tournaments again to retry.',
              'Не удалось загрузить команды и игроков. Повторите выбор турниров.',
            ),
            { tone: 'error' },
          );
      })
      .finally(() => {
        if (!cancelled) setPlayersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeImportId,
    decodedMap,
    playerScopeKey,
    saved,
    collectionId,
    saved ? favoritesRevision : 0,
  ]);

  useEffect(() => {
    let cancelled = false;
    setTournamentsLoading(true);
    setTournaments([]);
    (saved
      ? getFavoriteFilterOptions({
          map: decodedMap,
          collection_id: collectionId,
        }).then((options) => options.tournaments)
      : getImportTournaments(decodedMap)
    )
      .then((nextTournaments) => {
        if (cancelled) return;
        const available = Array.isArray(nextTournaments) ? nextTournaments : [];
        setTournaments(available);
        setFilters((state) => {
          const selected = (state.tournament ?? []).filter((name) =>
            available.some((option) => option.name === name),
          );
          return selected.length === (state.tournament ?? []).length
            ? state
            : { ...state, tournament: selected };
        });
      })
      .catch((error) => {
        console.error('Unable to load tournament filter options', error);
        if (!cancelled) setTournaments([]);
      })
      .finally(() => {
        if (!cancelled) setTournamentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeImportId,
    decodedMap,
    saved,
    collectionId,
    saved ? favoritesRevision : 0,
  ]);

  useEffect(() => {
    if (previousStorageKeyRef.current === stateStorageKey) return;
    previousStorageKeyRef.current = stateStorageKey;
    const isImportSwitch = previousImportIdRef.current !== activeImportId;
    previousImportIdRef.current = activeImportId;
    const nextViewState = readStoredMapViewState(
      stateStorageKey,
      viewDefaults(),
      defaultIconTheme,
    );
    skipNextStatePersistenceRef.current = true;
    restoredClusterIdRef.current = isImportSwitch
      ? (selectedCluster?.id ?? null)
      : (nextViewState?.selectedClusterId ?? null);
    restoredGrenadePageRef.current = isImportSwitch
      ? grenadePage
      : (nextViewState?.grenadePage ?? 0);
    if (!isImportSwitch) setFilters(nextViewState?.filters ?? viewDefaults());
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
      setIconTheme(nextViewState?.iconTheme ?? defaultIconTheme);
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

  const previousQueryRef = useRef(
    JSON.stringify([filters, radarMode, grenadeMode]),
  );
  useEffect(() => {
    const query = JSON.stringify([filters, radarMode, grenadeMode]);
    if (previousQueryRef.current !== query) {
      previousQueryRef.current = query;
      restoredGrenadePageRef.current = 0;
      setGrenadePage(0);
      setClusterPage(0);
    }
  }, [filters, radarMode, grenadeMode]);

  const favoriteFilters = (requestFilters: MapFilters): FavoriteFilters => ({
    map: decodedMap,
    collection_id: collectionId,
    grenade_type: requestFilters.grenade_type,
    side: requestFilters.side,
    search: requestFilters.search,
    movement: requestFilters.movement,
    jump: requestFilters.jump,
    is_insta: requestFilters.is_insta,
    radar_level: requestFilters.radar_level,
    thrower_team: requestFilters.thrower_team,
    thrower_steamid64: requestFilters.thrower_steamid64,
    tournament: requestFilters.tournament,
    min_usage: requestFilters.min_usage,
  });
  const overviewLoader = (map: string, requestFilters: MapFilters) =>
    saved
      ? getFavoriteMapOverview(
          map,
          favoriteFilters(requestFilters),
          grenadeMode,
        )
      : (grenadeMode === 'throw' ? getThrowOverview : getMapOverview)(
          map,
          requestFilters,
        );
  const clusterLoader = (
    map: string,
    clusterId: string,
    requestFilters: MapFilters,
    limit: number,
    offset: number,
  ) =>
    saved
      ? getFavoriteClusterGrenades(
          map,
          clusterId,
          { ...favoriteFilters(requestFilters), limit, offset },
          grenadeMode,
        )
      : (grenadeMode === 'throw'
          ? getThrowClusterGrenades
          : getClusterGrenades)(map, clusterId, requestFilters, limit, offset);

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
    clusterRequestRef.current += 1;
    mapTrajectoriesRequestRef.current += 1;
    Promise.all([
      overviewLoader(decodedMap, requestFilters),
      getSpawnPoints(decodedMap, 'Any'),
    ])
      .then(([nextOverview, nextSpawns]) => {
        if (overviewRequestRef.current === requestId) {
          setOverview(nextOverview);
          setSpawns(nextSpawns);
          setClusterPage((page) =>
            Math.min(
              page,
              Math.max(
                0,
                Math.ceil(nextOverview.clusters.length / clusterPageSize) - 1,
              ),
            ),
          );
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
          if (
            saved &&
            !nextOverview.clusters.some(
              (c) => c.id === restoredClusterIdRef.current,
            )
          ) {
            void loadClusterGrenades(null, restoredGrenadePageRef.current);
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
    return () => {
      ++overviewRequestRef.current;
      ++clusterRequestRef.current;
      ++mapTrajectoriesRequestRef.current;
    };
  }, [
    activeImportId,
    decodedMap,
    filters,
    grenadeMode,
    locale,
    overviewRetry,
    radarMode,
    siteMinUsage,
    saved,
    collectionId,
    saved || filters.favorites_only ? favoritesRevision : 0,
  ]);

  useEffect(() => {
    if (!overview || overview.map.has_lower_radar || radarMode === 'default')
      return;
    setRadarMode('default');
  }, [overview, radarMode]);

  const loadClusterGrenades = async (
    cluster: LandingCluster | null,
    page: number,
  ) => {
    const requestId = clusterRequestRef.current + 1;
    clusterRequestRef.current = requestId;
    setGrenadeLoading(true);
    setGrenadeError(null);

    try {
      if (!cluster && !saved) return;
      const result = cluster
        ? null
        : await listFavorites({
            ...favoriteFilters({ ...filters, radar_level: radarMode }),
            limit: grenadePageSize,
            offset: page * grenadePageSize,
          });
      if (clusterRequestRef.current !== requestId) return;
      if (result && page > 0 && page * grenadePageSize >= result.total) {
        await loadClusterGrenades(
          null,
          Math.max(0, Math.ceil(result.total / grenadePageSize) - 1),
        );
        return;
      }
      if (cluster && page > 0 && page * grenadePageSize >= cluster.count) {
        await loadClusterGrenades(
          cluster,
          Math.max(0, Math.ceil(cluster.count / grenadePageSize) - 1),
        );
        return;
      }
      const nextGrenades = result
        ? result.items
        : await clusterLoader(
            decodedMap,
            cluster!.id,
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
    try {
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
    } catch (error) {
      if (mapTrajectoriesRequestRef.current === requestId) {
        console.error(error);
        setGrenadeError(
          tr('Unable to load grenades', 'Не удалось загрузить гранаты'),
        );
      }
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
      clusterRequestRef.current += 1;
      if (saved) await loadClusterGrenades(null, 0);
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
  const grenadeTotal =
    selectedCluster?.count ?? (saved ? (overview?.grenade_count ?? 0) : 0);
  const grenadePageCount = Math.max(
    1,
    Math.ceil(grenadeTotal / grenadePageSize),
  );
  const grenadeStart = grenadeTotal ? grenadePage * grenadePageSize + 1 : 0;
  const grenadeEnd = Math.min(
    grenadeTotal,
    grenadePage * grenadePageSize + grenades.length,
  );
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
  const filtersAreDefault = filtersMatchDefault(filters, viewDefaults());
  const canResetFilters =
    !filtersAreDefault ||
    selectedCluster !== null ||
    clusterPage !== 0 ||
    grenadePage !== 0;
  const siteValue =
    pendingSiteMinUsage ?? (saved ? (filters.min_usage ?? 0) : siteMinUsage);
  const siteProgress = saved
    ? (siteValue / 50) * 100
    : ((siteValue - 1) / 49) * 100;
  const activeFilterCount = [
    filters.grenade_type !== 'all',
    filters.side !== 'Any',
    Boolean(filters.search?.trim()),
    Boolean(filters.thrower_team?.length),
    Boolean(filters.thrower_steamid64?.length),
    Boolean(filters.tournament?.length),
    filters.is_insta,
    filters.favorites_only,
    saved && (filters.min_usage ?? 0) > 0,
    (filters.movement ?? 'all') !== 'all',
    (filters.jump ?? 'all') !== 'all',
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
    (map) => saved || map.grenade_count > 0 || map.name === decodedMap,
  );
  const deduplicatePlayers = (source: ImportPlayerOption[]) =>
    Array.from(
      source
        .filter((player) => player.steamid64)
        .reduce((bySteamId, player) => {
          const existing = bySteamId.get(player.steamid64);
          if (!existing) {
            bySteamId.set(player.steamid64, {
              player: { ...player },
              teams: new Set(player.team_name ? [player.team_name] : []),
            });
            return bySteamId;
          }
          if (player.team_name) existing.teams.add(player.team_name);
          if (!existing.player.name && player.name)
            existing.player.name = player.name;
          return bySteamId;
        }, new globalThis.Map<string, { player: ImportPlayerOption; teams: Set<string> }>())
        .values(),
      ({ player, teams }) => ({
        ...player,
        team_name: Array.from(teams).sort().join(', '),
      }),
    );
  const allFilterablePlayers = deduplicatePlayers(players);
  const filterablePlayers = filters.thrower_team?.length
    ? deduplicatePlayers(
        players.filter((player) =>
          filters.thrower_team?.includes(player.team_name),
        ),
      )
    : allFilterablePlayers;
  const teams = Array.from(
    players.reduce((byTeam, player) => {
      if (!player.team_name || !player.steamid64) return byTeam;
      const steamIds = byTeam.get(player.team_name) ?? new Set<string>();
      steamIds.add(player.steamid64);
      byTeam.set(player.team_name, steamIds);
      return byTeam;
    }, new globalThis.Map<string, Set<string>>()),
    ([team_name, steamIds]): ImportTeamOption => ({
      team_name,
      player_count: steamIds.size,
    }),
  ).sort((left, right) => left.team_name.localeCompare(right.team_name));
  const teamFilterOptions: FilterSelectOption[] = [
    {
      value: '',
      label: tr('All teams', 'Все команды'),
      meta: count(
        teams.length,
        'team',
        'teams',
        'команда',
        'команды',
        'команд',
      ),
    },
    ...teams.map((team) => ({
      value: team.team_name,
      label: team.team_name,
      meta: count(
        team.player_count,
        'player',
        'players',
        'игрок',
        'игрока',
        'игроков',
      ),
    })),
  ];
  const playerFilterOptions: FilterSelectOption[] = [
    {
      value: '',
      label: tr('All players', 'Все игроки'),
      meta: count(
        filterablePlayers.length,
        'player',
        'players',
        'игрок',
        'игрока',
        'игроков',
      ),
    },
    ...filterablePlayers.map((player) => ({
      value: player.steamid64,
      label: player.name || player.steamid64,
      meta: player.team_name || player.side,
      searchText: `${player.steamid64} ${player.side}`,
    })),
  ];
  const tournamentFilterOptions: FilterSelectOption[] = [
    {
      value: '',
      label: tr('All tournaments', 'Все турниры'),
      meta: count(
        tournaments.length,
        'event',
        'events',
        'турнир',
        'турнира',
        'турниров',
      ),
    },
    ...tournaments.map((tournament) => ({
      value: tournament.name,
      label: tournament.name,
      meta:
        tournament.start_date === tournament.end_date
          ? tournament.start_date
          : `${tournament.start_date} - ${tournament.end_date}`,
    })),
  ];

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
    setPendingSiteMinUsage(null);
    setFilters(viewDefaults());
  };

  const updateTeamSelection = (values: string[]) => {
    setFilters((state) => {
      const next = { ...state, thrower_team: values };
      return playerOptionsAvailable
        ? reconcilePlayerSelections(next, players)
        : next;
    });
  };

  const clearFilter = (
    key: 'search' | 'thrower_team' | 'thrower_steamid64' | 'tournament',
    value?: string,
  ) => {
    if (key === 'search') {
      setFilters((state) => ({ ...state, search: '' }));
      return;
    }
    const values = (filters[key] ?? []).filter((item) => item !== value);
    if (key === 'thrower_team') updateTeamSelection(values);
    else setFilters((state) => ({ ...state, [key]: values }));
  };

  const applySiteSettings = async () => {
    if (saved) {
      if (pendingSiteMinUsage !== null)
        setFilters((current) => ({
          ...current,
          min_usage: pendingSiteMinUsage,
        }));
      setPendingSiteMinUsage(null);
      return;
    }
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
        <div className="map-toolbar" data-tour="map-workspace-toolbar">
          {!saved && (
            <button
              className="icon-btn"
              onClick={() => navigate('/maps')}
              aria-label={tr('Back to maps', 'К картам')}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div className="map-heading">
            {saved ? (
              <div className="favorites-current-map">
                <span className="map-selector-current">
                  <strong>{displayedMap?.label ?? decodedMap}</strong>
                  <span className="map-selector-filtered-count">
                    <small>
                      {loading
                        ? tr('Loading', 'Загрузка')
                        : tr('Filtered grenades', 'Гранат по фильтру')}
                    </small>
                    {!loading && (
                      <b>{formatNumber(overview?.grenade_count ?? 0)}</b>
                    )}
                  </span>
                </span>
              </div>
            ) : (
              <div
                className="map-selector"
                ref={mapSelectorRef}
                data-tour="map-selector"
              >
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
                      {mapOptionsError && (
                        <button
                          type="button"
                          onClick={() => setOverviewRetry((value) => value + 1)}
                        >
                          {tr('Retry', 'Повторить')}
                        </button>
                      )}
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
                            if (!active) {
                              navigate(`/map/${encodeURIComponent(map.name)}`);
                            }
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
            )}
          </div>
          <div className="toolbar-spacer" />
          {toolbar}
          {!saved && (
            <div className="map-favorites-controls">
              <div className="map-favorites-toggle-frame">
                <button
                  type="button"
                  className={`toggle map-favorites-toggle ${filters.favorites_only ? 'active' : ''}`}
                  aria-pressed={Boolean(filters.favorites_only)}
                  aria-label={tr('Favorites', 'Избранное')}
                  data-tip={tr('Favorites', 'Избранное')}
                  onClick={() => {
                    setFilters((current) => ({
                      ...current,
                      favorites_only: !current.favorites_only,
                    }));
                  }}
                >
                  <Star
                    size={15}
                    fill={filters.favorites_only ? 'currentColor' : 'none'}
                  />
                  <span>{tr('Favorites', 'Избранное')}</span>
                </button>
              </div>
              {favoritesError && (
                <button
                  className="icon-btn map-favorites-retry"
                  type="button"
                  aria-label={tr(
                    'Retry favorites',
                    'Повторить загрузку избранного',
                  )}
                  data-tip={tr(
                    'Retry favorites',
                    'Повторить загрузку избранного',
                  )}
                  onClick={() => void refreshFavorites()}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
          )}
          <div className="map-toolbar-actions" data-tour="map-toolbar-actions">
            <button
              className="toggle inspector-toggle"
              type="button"
              onClick={() => setInspectorVisible((visible) => !visible)}
              aria-pressed={!inspectorVisible}
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
              type="button"
              aria-pressed={iconTheme === 'asset'}
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
              aria-pressed={filters.is_insta}
              className={`toggle insta-toolbar-toggle ${filters.is_insta ? 'active' : ''}`}
              onClick={() =>
                setFilters((state) => ({ ...state, is_insta: !state.is_insta }))
              }
              data-tip={tr(
                'Show only insta grenades',
                'Показывать только инста-гранаты',
              )}
              aria-label={tr(
                'Show only insta grenades',
                'Показывать только инста-гранаты',
              )}
            >
              <Crosshair size={15} />
              {tr('Insta', 'Инста')}
            </button>
            <button
              aria-pressed={showSpawns}
              className={`toggle spawns-toolbar-toggle ${showSpawns ? 'active' : ''}`}
              onClick={() => setShowSpawns((value) => !value)}
              data-tip={tr('Toggle spawn points', 'Переключить точки спавнов')}
              aria-label={tr(
                'Toggle spawn points',
                'Переключить точки спавнов',
              )}
            >
              <LocateFixed size={15} />
              {tr('Spawns', 'Спавны')}
            </button>
            <button
              className={`toggle throw-toolbar-toggle ${grenadeMode === 'throw' ? 'active' : ''}`}
              type="button"
              onClick={() =>
                switchGrenadeMode(grenadeMode === 'throw' ? 'landing' : 'throw')
              }
              aria-pressed={grenadeMode === 'throw'}
              data-tip={tr(
                'Group by throw position',
                'Группировать по позиции броска',
              )}
            >
              <Send size={15} />
              {tr('Throw', 'Бросок')}
            </button>
          </div>
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
            radarControl={
              hasLowerRadar ? (
                <div
                  className="radar-switch"
                  role="group"
                  data-map-control="1"
                  aria-label={tr('Radar level', 'Уровень радара')}
                >
                  {radarLevels.map((level) => (
                    <button
                      key={level.key}
                      type="button"
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
                      <span
                        className="radar-switch-indicator"
                        aria-hidden="true"
                      />
                      {level.key === 'default'
                        ? tr('Main', 'Основной')
                        : tr('Lower', 'Нижний')}
                    </button>
                  ))}
                </div>
              ) : null
            }
            mapImagePath={mapImagePath}
            mapLabel={overview?.map.label ?? decodedMap}
            clusters={overview?.clusters}
            selectedClusterId={selectedCluster?.id}
            grenades={mapGrenades}
            grenadePointMode={grenadeMode === 'throw' ? 'landing' : 'throw'}
            spawnPoints={visibleSpawns}
            showSpawns={showSpawns || tutorialStep === 11}
            tutorialSpawnStep={tutorialStep === 11}
            iconTheme={iconTheme}
            onClusterSelect={selectCluster}
            onGrenadeOpen={(id) =>
              navigate(saved ? `/favorites/${id}` : `/grenade/${id}`)
            }
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
            <span className="filter-summary-queries">
              {filters.search?.trim() ? (
                <button
                  type="button"
                  className="filter-summary-chip"
                  onClick={() => clearFilter('search')}
                  aria-label={tr('Clear search filter', 'Сбросить поиск')}
                >
                  <Search size={11} aria-hidden="true" />
                  <span>{filters.search.trim()}</span>
                  <X size={11} aria-hidden="true" />
                </button>
              ) : null}
              {(filters.thrower_team ?? []).map((team) => (
                <button
                  key={team}
                  type="button"
                  className="filter-summary-chip"
                  onClick={() => clearFilter('thrower_team', team)}
                  aria-label={tr(
                    'Clear team filter',
                    'Сбросить фильтр команды',
                  )}
                >
                  <Users size={11} aria-hidden="true" />
                  <span>{team}</span>
                  <X size={11} aria-hidden="true" />
                </button>
              ))}
              {(filters.thrower_steamid64 ?? []).map((steamId) => (
                <button
                  key={steamId}
                  type="button"
                  className="filter-summary-chip"
                  onClick={() => clearFilter('thrower_steamid64', steamId)}
                  aria-label={tr(
                    'Clear player filter',
                    'Сбросить фильтр игрока',
                  )}
                >
                  <UserRound size={11} aria-hidden="true" />
                  <span>
                    {allFilterablePlayers.find(
                      (player) => player.steamid64 === steamId,
                    )?.name || steamId}
                  </span>
                  <X size={11} aria-hidden="true" />
                </button>
              ))}
              {(filters.tournament ?? []).map((tournament) => (
                <button
                  key={tournament}
                  type="button"
                  className="filter-summary-chip"
                  onClick={() => clearFilter('tournament', tournament)}
                  aria-label={tr(
                    'Clear tournament filter',
                    'Сбросить фильтр турнира',
                  )}
                >
                  <Trophy size={11} aria-hidden="true" />
                  <span>{tournament}</span>
                  <X size={11} aria-hidden="true" />
                </button>
              ))}
            </span>
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
          <div className="throw-filter-row">
            <div
              className={`throw-filter-group ${(filters.movement ?? 'all') !== 'all' ? 'has-value' : ''}`}
            >
              <span className="tactical-filter-label">
                {tr('Movement', 'Движение')}
                <span className="throw-filter-indicator" aria-hidden="true" />
              </span>
              <div
                className="throw-filter-options"
                role="group"
                aria-label={tr('Movement', 'Движение')}
              >
                {(['all', 'moving', 'stationary'] as const).map((movement) => {
                  const label =
                    movement === 'all'
                      ? tr('All movement types', 'Любое движение')
                      : movement === 'moving'
                        ? tr('Moving', 'В движении')
                        : tr('Stationary', 'Без движения');
                  return (
                    <button
                      key={movement}
                      type="button"
                      aria-label={label}
                      data-tip={label}
                      aria-pressed={(filters.movement ?? 'all') === movement}
                      data-filtered={movement !== 'all' ? 'true' : undefined}
                      onClick={() => {
                        restoredClusterIdRef.current = null;
                        restoredGrenadePageRef.current = 0;
                        setFilters((state) => ({ ...state, movement }));
                      }}
                    >
                      <ThrowMotionIcon kind={movement} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              className={`throw-filter-group ${(filters.jump ?? 'all') !== 'all' ? 'has-value' : ''}`}
            >
              <span className="tactical-filter-label">
                {tr('Jump', 'Прыжок')}
                <span className="throw-filter-indicator" aria-hidden="true" />
              </span>
              <div
                className="throw-filter-options"
                role="group"
                aria-label={tr('Jump', 'Прыжок')}
              >
                {(['all', 'jumping', 'grounded'] as const).map((jump) => {
                  const label =
                    jump === 'all'
                      ? tr('With or without jump', 'С прыжком или без')
                      : jump === 'jumping'
                        ? tr('With jump', 'С прыжком')
                        : tr('Without jump', 'Без прыжка');
                  return (
                    <button
                      key={jump}
                      type="button"
                      aria-label={label}
                      data-tip={label}
                      aria-pressed={(filters.jump ?? 'all') === jump}
                      data-filtered={jump !== 'all' ? 'true' : undefined}
                      onClick={() => {
                        restoredClusterIdRef.current = null;
                        restoredGrenadePageRef.current = 0;
                        setFilters((state) => ({ ...state, jump }));
                      }}
                    >
                      <ThrowMotionIcon kind={jump} />
                    </button>
                  );
                })}
              </div>
            </div>
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
          <div className="match-filter-section">
            <div className="filter-section-heading">
              <span>{tr('Filters', 'Фильтры')}</span>
            </div>
            <div className="match-filter-flow">
              <FilterSelect
                label={tr('Tournament', 'Турнир')}
                accent="tournament"
                value={filters.tournament ?? []}
                options={tournamentFilterOptions}
                selectedCountLabel={(n) =>
                  tr(`Selected: ${n}`, `Выбрано: ${n}`)
                }
                icon={null}
                searchPlaceholder={tr('Search tournaments', 'Найти турнир')}
                emptyLabel={tr('No tournaments found', 'Турниры не найдены')}
                loading={tournamentsLoading}
                loadingLabel={tr('Loading events', 'Загрузка турниров')}
                onChange={(value) =>
                  setFilters((state) => ({
                    ...state,
                    tournament: value,
                  }))
                }
              />
              <div className="filter-select-grid">
                <FilterSelect
                  label={tr('Team', 'Команда')}
                  accent="team"
                  value={filters.thrower_team ?? []}
                  options={teamFilterOptions}
                  selectedCountLabel={(n) =>
                    tr(`Selected: ${n}`, `Выбрано: ${n}`)
                  }
                  icon={null}
                  searchPlaceholder={tr('Search teams', 'Найти команду')}
                  emptyLabel={tr('No teams found', 'Команды не найдены')}
                  disabled={playersLoading || !playerOptionsAvailable}
                  onChange={updateTeamSelection}
                />
                <FilterSelect
                  label={tr('Player', 'Игрок')}
                  accent="player"
                  value={filters.thrower_steamid64 ?? []}
                  options={playerFilterOptions}
                  selectedCountLabel={(n) =>
                    tr(`Selected: ${n}`, `Выбрано: ${n}`)
                  }
                  icon={null}
                  searchPlaceholder={tr('Search players', 'Найти игрока')}
                  emptyLabel={tr('No players found', 'Игроки не найдены')}
                  disabled={playersLoading || !playerOptionsAvailable}
                  onChange={(value) =>
                    setFilters((state) => ({
                      ...state,
                      thrower_steamid64: value,
                    }))
                  }
                />
              </div>
            </div>
          </div>
        </div>

        <div
          className="panel-section inspector-visibility"
          data-tour="visibility-rules"
        >
          <button
            className="section-title section-toggle"
            type="button"
            onClick={() => setVisibilityRulesOpen((open) => !open)}
            aria-expanded={visibilityRulesOpen}
          >
            <span>{tr('Visibility rules', 'Правила видимости')}</span>
            <span className="section-toggle-meta">
              {!visibilityRulesOpen ? (
                <>
                  <span>{tr('Min.', 'Мин.')}</span>
                  <strong className="visibility-rule-count">{siteValue}</strong>
                </>
              ) : null}
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
                <span>
                  {saved
                    ? tr('Min usage', 'Минимум использований')
                    : tr('Public min usage', 'Минимум использований')}
                </span>
                <strong className="visibility-setting-value">
                  {siteValue}
                </strong>
              </div>
              <input
                className="range"
                type="range"
                min={saved ? 0 : 1}
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
              pendingSiteMinUsage !==
                (saved ? (filters.min_usage ?? 0) : siteMinUsage) ? (
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
          data-tour="grenade-list"
        >
          <div className="section-title">
            <span>
              {selectedCluster
                ? tr('Cluster lineups', 'Раскидки кластера')
                : saved
                  ? tr('Saved lineups', 'Сохранённые раскидки')
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
          {grenadeError && (selectedCluster || saved) ? (
            <div className="panel-load-error">
              <span>{grenadeError}</span>
              <button
                className="micro-btn"
                onClick={() =>
                  selectedCluster
                    ? retryClusterLoad(selectedCluster)
                    : void loadClusterGrenades(null, grenadePage)
                }
              >
                {tr('Retry', 'Повторить')}
              </button>
            </div>
          ) : (
            <GrenadeList
              grenades={grenades}
              saved={saved}
              compact
              showCopy
              loading={grenadeLoading || (saved && loading)}
              spawnPoints={visibleSpawns}
              emptyLabel={
                saved
                  ? tr(
                      'No saved lineups match these filters or collection.',
                      'В этой подборке или с такими фильтрами нет сохранённых раскидок.',
                    )
                  : tr(
                      'Choose a cluster on the map or from the list to inspect its lineups.',
                      'Выберите кластер на карте или в списке, чтобы изучить его раскидки.',
                    )
              }
            />
          )}
          {grenadeTotal > grenadePageSize ? (
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
                {formatNumber(grenadeTotal)}
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
