import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { FavoriteShareScope } from '../types/domain';
import type {
  FavoriteDetail,
  FavoriteFilters,
  FavoriteList,
  FavoritesState,
  GrenadeDetail,
  GrenadePreview,
  ImportPlayerOption,
  ImportStatus,
  ImportSummary,
  ImportTeamOption,
  ImportTournamentOption,
  JsonImportReport,
  LibraryUpdate,
  MapFilters,
  MapOverview,
  MapSummary,
  OnboardingState,
  SiteSettings,
  SpawnPoint,
  ViewedGrenade,
} from '../types/domain';

export const isTauri = '__TAURI_INTERNALS__' in window;

let initialization: Promise<void> | undefined;

export function initializeApplication() {
  initialization ??= new Promise<void>((resolve) => {
    // Let the browser paint the boot screen before starting native work.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }).then(() => (isTauri ? invoke<void>('initialize_application') : undefined));
  return initialization;
}

/** Event the backend broadcasts with a serialized `ImportStatus` snapshot. */
export const IMPORT_STATUS_EVENT = 'import-status';

export function assetUrl(path?: string | null) {
  if (!path) return '';
  if (!isTauri) return path;
  return convertFileSrc(path);
}

export function selectImportFile() {
  return invoke<string | null>('select_import_file');
}

export function importJson(path: string) {
  return invoke<JsonImportReport>('import_json', { path });
}

export function cancelImport() {
  return invoke<boolean>('cancel_import');
}

export function importParserWorkspace(source: string) {
  return invoke<JsonImportReport>('import_parser_workspace', { source });
}

export function getImportStatus() {
  return invoke<ImportStatus>('get_import_status');
}

export function checkLibraryUpdate() {
  return invoke<LibraryUpdate | null>('check_library_update');
}

export function importLibraryUpdate() {
  return invoke<JsonImportReport>('import_library_update');
}

export function cancelLibraryDownload() {
  return invoke<boolean>('cancel_library_download');
}

export function listImports() {
  return invoke<ImportSummary[]>('list_imports');
}

export function getImportTeams(map?: string, tournament?: string[]) {
  return invoke<ImportTeamOption[]>('get_import_teams', { map, tournament });
}

export function getImportPlayers(
  teamName?: string,
  map?: string,
  tournament?: string[],
) {
  return invoke<ImportPlayerOption[]>('get_import_players', {
    teamName,
    map,
    tournament,
  });
}

export function getImportTournaments(map?: string) {
  return invoke<ImportTournamentOption[]>('get_import_tournaments', { map });
}

export function setActiveImport(importId: number) {
  return invoke<ImportSummary>('set_active_import', { importId });
}

export function updateImportLabel(importId: number, label: string) {
  return invoke<ImportSummary>('update_import_label', { importId, label });
}

export function deleteImport(importId: number) {
  return invoke<ImportSummary | null>('delete_import', { importId });
}

export function getActiveImport() {
  return invoke<ImportSummary | null>('get_active_import');
}

export function getMaps() {
  return invoke<MapSummary[]>('get_maps');
}

export function getMapOverview(map: string, filters: MapFilters) {
  return invoke<MapOverview>('get_map_overview', { map, filters });
}

export function getThrowOverview(map: string, filters: MapFilters) {
  return invoke<MapOverview>('get_throw_overview', { map, filters });
}

export function getClusterGrenades(
  map: string,
  clusterId: string,
  filters: MapFilters,
  limit = 80,
  offset = 0,
) {
  return invoke<GrenadePreview[]>('get_cluster_grenades', {
    map,
    clusterId,
    filters,
    limit,
    offset,
  });
}

export function getThrowClusterGrenades(
  map: string,
  clusterId: string,
  filters: MapFilters,
  limit = 80,
  offset = 0,
) {
  return invoke<GrenadePreview[]>('get_throw_cluster_grenades', {
    map,
    clusterId,
    filters,
    limit,
    offset,
  });
}

export function getGrenade(id: number) {
  return invoke<GrenadeDetail>('get_grenade', { id });
}

export function listFavorites(filters: FavoriteFilters) {
  return invoke<FavoriteList>('list_favorites', { filters });
}

export function getFavoriteFilterOptions(filters: FavoriteFilters) {
  return invoke<{
    players: ImportPlayerOption[];
    tournaments: ImportTournamentOption[];
  }>('get_favorite_filter_options', { filters });
}

export function getFavoriteMaps() {
  return invoke<MapSummary[]>('get_favorite_maps');
}

export function getFavoriteMapOverview(
  map: string,
  filters: FavoriteFilters,
  mode: 'landing' | 'throw',
) {
  return invoke<MapOverview>('get_favorite_map_overview', {
    map,
    filters,
    mode,
  });
}

export function getFavoriteClusterGrenades(
  map: string,
  clusterId: string,
  filters: FavoriteFilters,
  mode: 'landing' | 'throw',
) {
  return invoke<GrenadePreview[]>('get_favorite_cluster_grenades', {
    map,
    clusterId,
    filters,
    mode,
  });
}

export function getFavorite(id: number) {
  return invoke<FavoriteDetail>('get_favorite', { id });
}

export function getFavoritesState() {
  return invoke<FavoritesState>('get_favorites_state');
}

export function exportFavoritesShare(scope: FavoriteShareScope) {
  return invoke<string | null>('export_favorites_share', { scope });
}

export function saveFavorite(id: number) {
  return invoke<number>('save_favorite', { id });
}

export function deleteFavorite(id: number) {
  return invoke<void>('delete_favorite', { id });
}

export function createFavoriteCollection(name: string, map: string) {
  return invoke<number>('create_favorite_collection', { name, map });
}

export function assignFavoriteCollectionMap(
  id: number,
  map: string,
  name: string,
) {
  return invoke<void>('assign_favorite_collection_map', { id, map, name });
}

export function renameFavoriteCollection(id: number, name: string) {
  return invoke<void>('rename_favorite_collection', { id, name });
}

export function deleteFavoriteCollection(id: number) {
  return invoke<void>('delete_favorite_collection', { id });
}

export function setFavoriteCollections(id: number, collectionIds: number[]) {
  return invoke<void>('set_favorite_collections', { id, collectionIds });
}

export function recordGrenadeView(id: number) {
  return invoke<boolean>('record_grenade_view', { id });
}

export function getRecentlyViewedGrenades(limit = 10) {
  return invoke<ViewedGrenade[]>('get_recently_viewed_grenades', { limit });
}

export function getSimilarGrenades(id: number, limit = 12) {
  return invoke<GrenadePreview[]>('get_similar_grenades', { id, limit });
}

export function getSpawnPoints(map: string, side: string) {
  return invoke<SpawnPoint[]>('get_spawn_points', { map, side });
}

export function getSiteSettings() {
  return invoke<SiteSettings>('get_site_settings');
}

export function updateSiteSettings(publicMinUsageCount: number) {
  return invoke<SiteSettings>('update_site_settings', { publicMinUsageCount });
}

export function getOnboardingState() {
  return invoke<OnboardingState>('get_onboarding_state');
}

export function completeOnboarding() {
  return invoke<OnboardingState>('complete_onboarding');
}

export function resetOnboarding() {
  return invoke<OnboardingState>('reset_onboarding');
}
