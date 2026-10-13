import type { IconTheme } from '../components/MapCanvas';
import type { MapFilters } from '../types/domain';
import { normalizeFilterSelection } from '../lib/mapFilterSelection';

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
  movement: 'all',
  jump: 'all',
  search: '',
  thrower_team: [],
  thrower_steamid64: [],
  tournament: [],
  min_usage: 0,
  is_insta: false,
  favorites_only: false,
  favorite_collection_id: undefined,
});

export function filtersMatchDefault(filters: MapFilters) {
  const defaults = defaultMapFilters();
  return (
    filters.grenade_type === defaults.grenade_type &&
    filters.side === defaults.side &&
    (filters.movement ?? 'all') === defaults.movement &&
    (filters.jump ?? 'all') === defaults.jump &&
    (filters.search ?? '') === defaults.search &&
    !filters.thrower_team?.length &&
    !filters.thrower_steamid64?.length &&
    !filters.tournament?.length &&
    (filters.min_usage ?? 0) === defaults.min_usage &&
    Boolean(filters.is_insta) === Boolean(defaults.is_insta) &&
    !filters.favorites_only &&
    filters.favorite_collection_id === undefined
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
      filters: {
        ...defaultMapFilters(),
        ...Object.fromEntries(
          Object.entries(parsed.filters ?? {}).filter(([key]) =>
            Object.prototype.hasOwnProperty.call(defaultMapFilters(), key),
          ),
        ),
        movement:
          parsed.filters?.movement === 'moving' ||
          parsed.filters?.movement === 'stationary'
            ? parsed.filters.movement
            : 'all',
        jump:
          parsed.filters?.jump === 'jumping' ||
          parsed.filters?.jump === 'grounded'
            ? parsed.filters.jump
            : 'all',
        thrower_team: normalizeFilterSelection(parsed.filters?.thrower_team),
        thrower_steamid64: normalizeFilterSelection(
          parsed.filters?.thrower_steamid64,
        ),
        tournament: normalizeFilterSelection(parsed.filters?.tournament),
        favorites_only: parsed.filters?.favorites_only === true,
        favorite_collection_id:
          typeof parsed.filters?.favorite_collection_id === 'number' &&
          Number.isInteger(parsed.filters.favorite_collection_id) &&
          parsed.filters.favorite_collection_id > 0
            ? parsed.filters.favorite_collection_id
            : undefined,
      },
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
