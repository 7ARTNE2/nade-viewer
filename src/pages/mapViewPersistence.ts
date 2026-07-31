import type { IconTheme } from '../components/MapCanvas';
import type { MapFilters } from '../types/domain';

export const radarLevels = [
  { key: 'default', label: 'Main' },
  { key: 'lower', label: 'Lower' },
] as const;

export type RadarMode = (typeof radarLevels)[number]['key'];
export type GrenadeMode = 'landing' | 'throw';

export type StoredMapViewState = {
  filters: MapFilters;
  selectedClusterId: string | null;
  clusterPage: number;
  grenadePage: number;
  showSpawns: boolean;
  radarMode: RadarMode;
  grenadeMode: GrenadeMode;
  iconTheme: IconTheme;
};

export const defaultMapFilters = (): MapFilters => ({
  grenade_type: 'smoke',
  side: 'T',
  search: '',
  thrower_team: '',
  min_usage: 0,
  is_core: false,
});

export function filtersMatchDefault(filters: MapFilters) {
  const defaults = defaultMapFilters();
  return (
    filters.grenade_type === defaults.grenade_type &&
    filters.side === defaults.side &&
    (filters.search ?? '') === defaults.search &&
    (filters.thrower_team ?? '') === defaults.thrower_team &&
    (filters.min_usage ?? 0) === defaults.min_usage &&
    Boolean(filters.is_core) === Boolean(defaults.is_core)
  );
}

export function mapViewStorageKey(activeImportId: number, map: string) {
  return `nadeviewer.map-view.${activeImportId}.${map}`;
}

function normalizeStoredNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizeStoredRadarMode(value: unknown): RadarMode {
  return value === 'lower' ? 'lower' : 'default';
}

function normalizeStoredGrenadeMode(value: unknown): GrenadeMode {
  return value === 'throw' ? 'throw' : 'landing';
}

function normalizeStoredIconTheme(value: unknown): IconTheme {
  return value === 'asset' ? 'asset' : 'base';
}

export function readStoredMapViewState(key: string): StoredMapViewState | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMapViewState>;
    const selectedClusterId =
      typeof parsed.selectedClusterId === 'string'
        ? parsed.selectedClusterId
        : null;
    return {
      filters: { ...defaultMapFilters(), ...(parsed.filters ?? {}) },
      selectedClusterId,
      clusterPage: normalizeStoredNumber(parsed.clusterPage, 0),
      grenadePage: normalizeStoredNumber(parsed.grenadePage, 0),
      showSpawns:
        typeof parsed.showSpawns === 'boolean' ? parsed.showSpawns : true,
      radarMode: normalizeStoredRadarMode(parsed.radarMode),
      grenadeMode: normalizeStoredGrenadeMode(parsed.grenadeMode),
      iconTheme: normalizeStoredIconTheme(parsed.iconTheme),
    };
  } catch {
    return null;
  }
}

export function writeStoredMapViewState(
  key: string,
  state: StoredMapViewState,
) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Session storage can be unavailable in constrained webviews.
  }
}
