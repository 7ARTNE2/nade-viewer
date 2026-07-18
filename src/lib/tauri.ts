import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type {
  CoreNadesExportReport,
  GrenadeDetail,
  GrenadePreview,
  ImportStatus,
  ImportSummary,
  JsonImportReport,
  MapFilters,
  MapOverview,
  MapSummary,
  OnboardingState,
  SiteSettings,
  SpawnPoint,
  ViewedGrenade,
} from '../types/domain';

export const isTauri = '__TAURI_INTERNALS__' in window;

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

export function getImportStatus() {
  return invoke<ImportStatus>('get_import_status');
}

export function listImports() {
  return invoke<ImportSummary[]>('list_imports');
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

export function recordGrenadeView(id: number) {
  return invoke<boolean>('record_grenade_view', { id });
}

export function getRecentlyViewedGrenades(limit = 8) {
  return invoke<ViewedGrenade[]>('get_recently_viewed_grenades', { limit });
}

export function setGrenadeCore(id: number, isCore: boolean) {
  return invoke<boolean>('set_grenade_core', { id, isCore });
}

export function exportCoreNades() {
  return invoke<CoreNadesExportReport | null>('export_core_nades');
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
