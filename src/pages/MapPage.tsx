import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BadgeCheck, ChevronLeft, ChevronRight, Filter, LocateFixed, RotateCcw, Search, Send, Shapes } from "lucide-react";
import MapCanvas, { type IconTheme } from "../components/MapCanvas";
import GrenadeList from "../components/GrenadeList";
import { getClusterGrenades, getMapOverview, getSiteSettings, getSpawnPoints, getThrowClusterGrenades, getThrowOverview, setGrenadeCore, updateSiteSettings } from "../lib/tauri";
import { formatNumber, grenadeLabel } from "../lib/format";
import type { GrenadePreview, LandingCluster, MapFilters, MapOverview, SpawnPoint } from "../types/domain";
import { useI18n } from "../i18n";

const grenadeTypes = ["all", "smoke", "flash", "molotov", "HE"];
const sides = ["Any", "T", "CT"];
const radarLevels = [
  { key: "default", label: "Main" },
  { key: "lower", label: "Lower" },
] as const;
const clusterAccentRgb: Record<string, string> = {
  T: "249, 115, 22",
  CT: "96, 165, 250",
  MIX: "167, 139, 250",
  NEUTRAL: "226, 232, 240",
};
const clusterPageSize = 12;
const grenadePageSize = 30;
const mapTrajectoryPreviewLimit = 120;

type MapPageProps = {
  activeImportId: number;
};

type RadarMode = (typeof radarLevels)[number]["key"];

type GrenadeMode = "landing" | "throw";

type StoredMapViewState = {
  filters: MapFilters;
  selectedClusterId: string | null;
  clusterPage: number;
  grenadePage: number;
  showSpawns: boolean;
  radarMode: RadarMode;
  grenadeMode: GrenadeMode;
  iconTheme: IconTheme;
};

const defaultMapFilters = (): MapFilters => ({ grenade_type: "smoke", side: "T", search: "", min_usage: 0, is_core: false });

function filtersMatchDefault(filters: MapFilters) {
  const defaults = defaultMapFilters();
  return (
    filters.grenade_type === defaults.grenade_type &&
    filters.side === defaults.side &&
    (filters.search ?? "") === defaults.search &&
    (filters.min_usage ?? 0) === defaults.min_usage &&
    Boolean(filters.is_core) === Boolean(defaults.is_core)
  );
}

function mapViewStorageKey(activeImportId: number, map: string) {
  return `nadeviewer.map-view.${activeImportId}.${map}`;
}

function normalizeStoredNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeStoredRadarMode(value: unknown): RadarMode {
  return value === "lower" ? "lower" : "default";
}

function normalizeStoredGrenadeMode(value: unknown): GrenadeMode {
  return value === "throw" ? "throw" : "landing";
}

function normalizeStoredIconTheme(value: unknown): IconTheme {
  return value === "asset" ? "asset" : "base";
}

function readStoredMapViewState(key: string): StoredMapViewState | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMapViewState>;
    const selectedClusterId = typeof parsed.selectedClusterId === "string" ? parsed.selectedClusterId : null;
    return {
      filters: { ...defaultMapFilters(), ...(parsed.filters ?? {}) },
      selectedClusterId,
      clusterPage: normalizeStoredNumber(parsed.clusterPage, 0),
      grenadePage: normalizeStoredNumber(parsed.grenadePage, 0),
      showSpawns: typeof parsed.showSpawns === "boolean" ? parsed.showSpawns : true,
      radarMode: normalizeStoredRadarMode(parsed.radarMode),
      grenadeMode: normalizeStoredGrenadeMode(parsed.grenadeMode),
      iconTheme: normalizeStoredIconTheme(parsed.iconTheme),
    };
  } catch {
    return null;
  }
}

function writeStoredMapViewState(key: string, state: StoredMapViewState) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Session storage can be unavailable in constrained webviews.
  }
}

export default function MapPage({ activeImportId }: MapPageProps) {
  const { locale, tr } = useI18n();
  const { mapName = "" } = useParams();
  const navigate = useNavigate();
  const decodedMap = useMemo(() => {
    try {
      return decodeURIComponent(mapName);
    } catch {
      return mapName;
    }
  }, [mapName]);
  const stateStorageKey = useMemo(() => mapViewStorageKey(activeImportId, decodedMap), [activeImportId, decodedMap]);
  const initialViewStateRef = useRef<StoredMapViewState | null | undefined>(undefined);
  if (initialViewStateRef.current === undefined) {
    initialViewStateRef.current = readStoredMapViewState(stateStorageKey);
  }
  const initialViewState = initialViewStateRef.current;
  const [filters, setFilters] = useState<MapFilters>(() => initialViewState?.filters ?? defaultMapFilters());
  const [overview, setOverview] = useState<MapOverview | null>(null);
  const [spawns, setSpawns] = useState<SpawnPoint[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<LandingCluster | null>(null);
  const [grenades, setGrenades] = useState<GrenadePreview[]>([]);
  const [mapGrenades, setMapGrenades] = useState<GrenadePreview[]>([]);
  const [clusterPage, setClusterPage] = useState(initialViewState?.clusterPage ?? 0);
  const [grenadePage, setGrenadePage] = useState(initialViewState?.grenadePage ?? 0);
  const [grenadeLoading, setGrenadeLoading] = useState(false);
  const [showSpawns, setShowSpawns] = useState(initialViewState?.showSpawns ?? true);
  const [loading, setLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [grenadeError, setGrenadeError] = useState<string | null>(null);
  const [overviewRetry, setOverviewRetry] = useState(0);
  const [radarMode, setRadarMode] = useState<RadarMode>(initialViewState?.radarMode ?? "default");
  const [grenadeMode, setGrenadeMode] = useState<GrenadeMode>(initialViewState?.grenadeMode ?? "landing");
  const [iconTheme, setIconTheme] = useState<IconTheme>(initialViewState?.iconTheme ?? "base");
  const [siteMinUsage, setSiteMinUsage] = useState(1);
  const [pendingSiteMinUsage, setPendingSiteMinUsage] = useState<number | null>(null);
  const overviewRequestRef = useRef(0);
  const clusterRequestRef = useRef(0);
  const mapTrajectoriesRequestRef = useRef(0);
  const restoredClusterIdRef = useRef<string | null>(initialViewState?.selectedClusterId ?? null);
  const restoredGrenadePageRef = useRef(initialViewState?.grenadePage ?? 0);
  const previousStorageKeyRef = useRef(stateStorageKey);

  useEffect(() => {
    getSiteSettings()
      .then((settings) => setSiteMinUsage(settings.public_min_usage_count))
      .catch(() => setSiteMinUsage(1));
  }, []);

  useEffect(() => {
    if (previousStorageKeyRef.current === stateStorageKey) return;
    previousStorageKeyRef.current = stateStorageKey;
    const nextViewState = readStoredMapViewState(stateStorageKey);
    restoredClusterIdRef.current = nextViewState?.selectedClusterId ?? null;
    restoredGrenadePageRef.current = nextViewState?.grenadePage ?? 0;
    setFilters(nextViewState?.filters ?? defaultMapFilters());
    setSelectedCluster(null);
    setGrenades([]);
    setMapGrenades([]);
    setClusterPage(nextViewState?.clusterPage ?? 0);
    setGrenadePage(nextViewState?.grenadePage ?? 0);
    setShowSpawns(nextViewState?.showSpawns ?? true);
    setRadarMode(nextViewState?.radarMode ?? "default");
    setGrenadeMode(nextViewState?.grenadeMode ?? "landing");
    setIconTheme(nextViewState?.iconTheme ?? "base");
    clusterRequestRef.current += 1;
    mapTrajectoriesRequestRef.current += 1;
  }, [stateStorageKey]);

  useEffect(() => {
    if (selectedCluster) {
      restoredClusterIdRef.current = selectedCluster.id;
      restoredGrenadePageRef.current = grenadePage;
    }
    writeStoredMapViewState(stateStorageKey, {
      filters,
      selectedClusterId: selectedCluster?.id ?? restoredClusterIdRef.current,
      clusterPage,
      grenadePage: selectedCluster ? grenadePage : restoredGrenadePageRef.current,
      showSpawns,
      radarMode,
      grenadeMode,
      iconTheme,
    });
  }, [clusterPage, filters, grenadePage, grenadeMode, iconTheme, radarMode, selectedCluster, showSpawns, stateStorageKey]);

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
    const overviewLoader = grenadeMode === "throw" ? getThrowOverview : getMapOverview;
    Promise.all([overviewLoader(decodedMap, requestFilters), getSpawnPoints(decodedMap, "Any")])
      .then(([nextOverview, nextSpawns]) => {
        if (overviewRequestRef.current === requestId) {
          setOverview(nextOverview);
          setSpawns(nextSpawns);
          const restoreClusterId = restoredClusterIdRef.current;
          if (restoreClusterId) {
            const restoredCluster = nextOverview.clusters.find((cluster) => cluster.id === restoreClusterId) ?? null;
            if (restoredCluster) {
              setSelectedCluster(restoredCluster);
              Promise.all([
                loadClusterGrenades(restoredCluster, restoredGrenadePageRef.current),
                loadClusterMapGrenades(restoredCluster),
              ]).catch((error) => {
                console.error(error);
                setGrenadeError(tr("Unable to load grenades", "Не удалось загрузить гранаты"));
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
          setOverviewError(tr("Unable to load map overview", "Не удалось загрузить обзор карты"));
        }
      })
      .finally(() => {
        if (overviewRequestRef.current === requestId) {
          setLoading(false);
        }
      });
  }, [activeImportId, decodedMap, filters, grenadeMode, locale, overviewRetry, radarMode, siteMinUsage]);

  useEffect(() => {
    if (!overview || overview.map.has_lower_radar || radarMode === "default") return;
    setRadarMode("default");
  }, [overview, radarMode]);

  const loadClusterGrenades = async (cluster: LandingCluster, page: number) => {
    const requestId = clusterRequestRef.current + 1;
    clusterRequestRef.current = requestId;
    setGrenadeLoading(true);
    setGrenadeError(null);

    try {
      const clusterLoader = grenadeMode === "throw" ? getThrowClusterGrenades : getClusterGrenades;
      const nextGrenades = await clusterLoader(decodedMap, cluster.id, { ...filters, radar_level: radarMode }, grenadePageSize, page * grenadePageSize);
      if (clusterRequestRef.current === requestId) {
        setGrenades(nextGrenades);
        setGrenadePage(page);
        restoredGrenadePageRef.current = page;
      }
    } catch (error) {
      if (clusterRequestRef.current === requestId) {
        console.error(error);
        setGrenadeError(tr("Unable to load grenades", "Не удалось загрузить гранаты"));
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
    const clusterLoader = grenadeMode === "throw" ? getThrowClusterGrenades : getClusterGrenades;
    const nextGrenades = await clusterLoader(decodedMap, cluster.id, { ...filters, radar_level: radarMode }, mapTrajectoryPreviewLimit, 0);
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
      await Promise.all([loadClusterGrenades(cluster, 0), loadClusterMapGrenades(cluster)]);
    } catch (error) {
      console.error(error);
      setGrenadeError(tr("Unable to load grenades", "Не удалось загрузить гранаты"));
      setGrenades([]);
      setMapGrenades([]);
    }
  };

  const clusters = overview?.clusters ?? [];
  const clusterPageCount = Math.max(1, Math.ceil(clusters.length / clusterPageSize));
  const visibleClusters = useMemo(() => clusters.slice(clusterPage * clusterPageSize, (clusterPage + 1) * clusterPageSize), [clusters, clusterPage]);
  const grenadePageCount = selectedCluster ? Math.max(1, Math.ceil(selectedCluster.count / grenadePageSize)) : 1;
  const grenadeStart = selectedCluster ? grenadePage * grenadePageSize + 1 : 0;
  const grenadeEnd = selectedCluster ? Math.min(selectedCluster.count, grenadePage * grenadePageSize + grenades.length) : 0;
  const hasLowerRadar = overview?.map.has_lower_radar === true;
  const mapImagePath = hasLowerRadar && radarMode === "lower" && overview?.map.lower_map_image_path
    ? overview.map.lower_map_image_path
    : overview?.map.map_image_path;
  const visibleSpawns = useMemo(() => {
    const split = overview?.map.radar_split_z;
    if (!hasLowerRadar || typeof split !== "number") return spawns;
    return spawns.filter((spawn) => (radarMode === "lower" ? spawn.pos_z <= split : spawn.pos_z > split));
  }, [hasLowerRadar, overview?.map.radar_split_z, radarMode, spawns]);
  const filtersAreDefault = useMemo(() => filtersMatchDefault(filters), [filters]);
  const canResetFilters = !filtersAreDefault || selectedCluster !== null || clusterPage !== 0 || grenadePage !== 0;
  const siteValue = pendingSiteMinUsage ?? siteMinUsage;
  const siteProgress = ((siteValue - 1) / 49) * 100;

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
    if (pendingSiteMinUsage === null || pendingSiteMinUsage === siteMinUsage) return;
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
        : list.map((grenade) => (grenade.id === id ? { ...grenade, is_core: isCore } : grenade)),
    );
    setMapGrenades((list) =>
      filters.is_core && !isCore
        ? list.filter((grenade) => grenade.id !== id)
        : list.map((grenade) => (grenade.id === id ? { ...grenade, is_core: isCore } : grenade)),
    );

    try {
      await setGrenadeCore(id, isCore);
      const overviewLoader = grenadeMode === "throw" ? getThrowOverview : getMapOverview;
      const nextOverview = await overviewLoader(decodedMap, { ...filters, radar_level: radarMode });
      if (overviewRequestRef.current === requestId) {
        setOverview(nextOverview);
      }
    } catch (error) {
      console.error(error);
      if (overviewRequestRef.current === requestId) {
        setGrenades(previousGrenades);
        setMapGrenades(previousMapGrenades);
      }
    }
  };

  const retryClusterLoad = (cluster: LandingCluster) => {
    setGrenadeError(null);
    Promise.all([loadClusterGrenades(cluster, grenadePage), loadClusterMapGrenades(cluster)]).catch((error) => {
      console.error(error);
      setGrenadeError(tr("Unable to load grenades", "Не удалось загрузить гранаты"));
    });
  };

  return (
    <div className="map-workspace">
      <section className="map-main-panel">
          <div className="map-toolbar" data-tour="map-workspace-toolbar">
          <button className="icon-btn" onClick={() => navigate("/maps")}>
            <ArrowLeft size={16} />
          </button>
          <div className="map-heading">
            <strong>{overview?.map.label ?? decodedMap}</strong>
            <span>{loading ? tr("Loading overview", "Загрузка обзора") : `${formatNumber(overview?.grenade_count ?? 0)} ${tr("filtered grenades", "гранат по фильтру")}`}</span>
          </div>
          <div className="toolbar-spacer" />
          <button
            className={`toggle map-appearance-toggle ${iconTheme === "asset" ? "active" : ""}`}
            onClick={() => setIconTheme((theme) => theme === "base" ? "asset" : "base")}
            data-tip={tr("Toggle grenade point icons", "Переключить значки точек")}
            aria-label={tr("Toggle grenade point icons", "Переключить значки точек")}
          >
            <Shapes size={15} />
            {tr("Icons", "Значки")}
          </button>
          <button className={`toggle core-toolbar-toggle ${filters.is_core ? "active" : ""}`} onClick={() => setFilters((state) => ({ ...state, is_core: !state.is_core }))}>
            <BadgeCheck size={15} />
            Core
          </button>
          <button className={`toggle ${showSpawns ? "active" : ""}`} onClick={() => setShowSpawns((value) => !value)}>
            <LocateFixed size={15} />
            {tr("Spawns", "Спавны")}
          </button>
          <button
            className={`toggle throw-toolbar-toggle ${grenadeMode === "throw" ? "active" : ""}`}
            onClick={() => switchGrenadeMode(grenadeMode === "throw" ? "landing" : "throw")}
            data-tip={tr("Group by throw position", "Группировать по позиции броска")}
          >
            <Send size={15} />
            {tr("Throw", "Бросок")}
          </button>
          {hasLowerRadar ? (
            <div className="radar-switch" aria-label="Radar level">
              {radarLevels.map((level) => (
                <button
                  key={level.key}
                  className={radarMode === level.key ? "active" : ""}
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
                  {level.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {overviewError ? (
          <div className="detail-load-error">
            <strong>{tr("Unable to open map", "Не удалось открыть карту")}</strong>
            <p>{overviewError}</p>
            <button className="btn primary" onClick={() => setOverviewRetry((value) => value + 1)}>{tr("Retry", "Повторить")}</button>
          </div>
        ) : (
          <MapCanvas
            mapImagePath={mapImagePath}
            clusters={overview?.clusters}
            selectedClusterId={selectedCluster?.id}
            grenades={mapGrenades}
            grenadePointMode={grenadeMode === "throw" ? "landing" : "throw"}
            spawnPoints={visibleSpawns}
            showSpawns={showSpawns}
            iconTheme={iconTheme}
            onClusterSelect={selectCluster}
            onGrenadeOpen={(id) => navigate(`/grenade/${id}`)}
          />
        )}
      </section>

      <aside className="inspector">
        <div className="panel-section compact-filter inspector-filter" data-tour="map-filters">
          <div className="section-title">
            <span>
              <Filter size={15} />
               {tr("Filters", "Фильтры")}
            </span>
            <button className="micro-btn filter-reset-btn" type="button" onClick={resetFilters} disabled={!canResetFilters} data-tip={tr("Reset filters", "Сбросить фильтры")}>
              <RotateCcw size={13} />
              {tr("Reset", "Сбросить")}
            </button>
          </div>
          <div className="segmented">
            {grenadeTypes.map((type) => (
              <button
                key={type}
                className={`filter-btn filter-${String(type).toLowerCase()} ${filters.grenade_type === type ? "active" : ""}`}
                onClick={() => setFilters((state) => ({ ...state, grenade_type: type }))}
              >
                {type === "all" ? tr("All", "Все") : grenadeLabel(type)}
              </button>
            ))}
          </div>
          <div className="segmented three">
            {sides.map((side) => (
              <button key={side} className={`filter-btn side-${side.toLowerCase()} ${filters.side === side ? "active" : ""}`} onClick={() => setFilters((state) => ({ ...state, side }))}>
                {side}
              </button>
            ))}
          </div>
          <label className="mini-field">
            <Search size={14} />
            <input value={filters.search ?? ""} onChange={(event) => setFilters((state) => ({ ...state, search: event.target.value }))} placeholder={tr("Thrower, demo, command", "Игрок, демо, команда")} />
          </label>
        </div>

        <div className="panel-section inspector-visibility">
          <div className="section-title">{tr("Visibility rules", "Правила видимости")}</div>
          <div className="setting-card">
            <div className="setting-row">
              <span>{tr("Public min usage", "Минимум использований")}</span>
              <strong>{siteValue}</strong>
            </div>
            <input
              className="range"
              type="range"
              min="1"
              max="50"
              step="1"
              value={siteValue}
              onChange={(event) => setPendingSiteMinUsage(Number(event.target.value))}
              style={{ "--range-progress": `${siteProgress}%` } as React.CSSProperties}
            />
            {pendingSiteMinUsage !== null && pendingSiteMinUsage !== siteMinUsage ? (
              <div className="setting-actions">
                <button onClick={() => applySiteSettings().catch(console.error)}>{tr("Apply", "Применить")}</button>
                <button onClick={() => setPendingSiteMinUsage(null)}>{tr("Cancel", "Отмена")}</button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="panel-section cluster-panel inspector-clusters" data-tour="cluster-list">
          <div className="section-title">
            {grenadeMode === "throw" ? tr("Throw clusters", "Кластеры бросков") : tr("Landing clusters", "Кластеры приземления")}
            <span className="section-count">{clusters.length ? `${clusterPage + 1}/${clusterPageCount}` : "0"}</span>
          </div>
          <div className="cluster-list">
            {visibleClusters.map((cluster) => (
              <button
                key={cluster.id}
                className={selectedCluster?.id === cluster.id ? "selected" : ""}
                style={{ "--cluster-rgb": clusterAccentRgb[cluster.side_key] ?? clusterAccentRgb.NEUTRAL } as React.CSSProperties}
                onClick={() => selectCluster(cluster).catch(console.error)}
              >
                <span className={`cluster-side ${cluster.side_key.toLowerCase()}`}>{cluster.side_key}</span>
                <strong>{cluster.count}</strong>
                <small>{cluster.unique_types.map(grenadeLabel).join(", ")}</small>
              </button>
            ))}
          </div>
          {clusterPageCount > 1 ? (
            <div className="panel-pager">
              <button onClick={() => setClusterPage((page) => Math.max(0, page - 1))} disabled={clusterPage === 0} aria-label="Previous landing clusters">
                <ChevronLeft size={14} />
              </button>
              <span>{clusterPage * clusterPageSize + 1}-{Math.min(clusters.length, (clusterPage + 1) * clusterPageSize)} of {formatNumber(clusters.length)}</span>
              <button onClick={() => setClusterPage((page) => Math.min(clusterPageCount - 1, page + 1))} disabled={clusterPage >= clusterPageCount - 1} aria-label="Next landing clusters">
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
          {overview?.clusters_truncated ? (
            <div className="cluster-limit-note">
              {tr("Showing the 2,000 largest clusters.", "Показаны 2 000 крупнейших кластеров.")}
            </div>
          ) : null}
        </div>

        <div className="panel-section grenade-panel inspector-grenades">
          <div className="section-title">
            {tr("Selected grenades", "Выбранные гранаты")}
            {selectedCluster ? <span className="section-count">{formatNumber(selectedCluster.count)}</span> : null}
          </div>
          {grenadeError && selectedCluster ? (
            <div className="panel-load-error">
              <span>{grenadeError}</span>
              <button className="micro-btn" onClick={() => retryClusterLoad(selectedCluster)}>{tr("Retry", "Повторить")}</button>
            </div>
          ) : (
            <GrenadeList
              grenades={grenades}
              compact
              showCopy
              spawnPoints={visibleSpawns}
              onCoreToggle={handleCoreToggle}
              emptyLabel={grenadeLoading ? tr("Loading grenades.", "Загрузка гранат.") : filters.is_core ? tr("No Core Nades in this cluster.", "В этом кластере нет Core Nades.") : undefined}
            />
          )}
          {selectedCluster && selectedCluster.count > grenadePageSize ? (
            <div className="panel-pager">
              <button onClick={() => loadClusterGrenades(selectedCluster, Math.max(0, grenadePage - 1))} disabled={grenadeLoading || grenadePage === 0} aria-label="Previous selected grenades">
                <ChevronLeft size={14} />
              </button>
              <span>{grenadeStart}-{grenadeEnd} of {formatNumber(selectedCluster.count)}</span>
              <button
                onClick={() => loadClusterGrenades(selectedCluster, Math.min(grenadePageCount - 1, grenadePage + 1))}
                disabled={grenadeLoading || grenadePage >= grenadePageCount - 1}
                aria-label="Next selected grenades"
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
