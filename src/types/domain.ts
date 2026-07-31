export type ImportStatus = {
  running: boolean;
  stage: string;
  current: number;
  total: number;
  message: string;
  error?: string | null;
};

export type ImportSummary = {
  id: number;
  source_path: string;
  kind: 'grenade_index' | 'core_nades' | string;
  label?: string | null;
  imported_at: string;
  parser_version?: number | null;
  parser_updated_at?: string | null;
  grenade_count: number;
  map_count: number;
  is_active: boolean;
};

export type SiteSettings = {
  public_min_usage_count: number;
};

export type OnboardingState = {
  completed: boolean;
};

export type CoreNadesExportReport = {
  path: string;
  grenade_count: number;
};

export type JsonImportReport =
  | {
      kind: 'grenade_index';
      import_id: number;
      grenade_count: number;
      map_count: number;
      source_path: string;
    }
  | {
      kind: 'core_nades';
      import_id: number;
      grenade_count: number;
      map_count: number;
      source_path: string;
    };

export type MapSummary = {
  name: string;
  label: string;
  grenade_count: number;
  preview_image_path?: string | null;
  map_image_path?: string | null;
  lower_map_image_path?: string | null;
  has_lower_radar: boolean;
  radar_split_z?: number | null;
  radar_scale?: number | null;
};

export type MapFilters = {
  grenade_type?: string;
  side?: string;
  search?: string;
  thrower_team?: string;
  min_usage?: number;
  radar_level?: 'default' | 'lower';
  is_core?: boolean;
};

export type LandingCluster = {
  id: string;
  x: number;
  y: number;
  count: number;
  first_grenade_id: number;
  side_key: 'T' | 'CT' | 'MIX' | 'NEUTRAL' | string;
  unique_types: string[];
  radar_level: 'default' | 'lower' | 'unknown' | string;
};

export type MapOverview = {
  map: MapSummary;
  grenade_count: number;
  clusters: LandingCluster[];
  type_counts: Record<string, number>;
  side_counts: Record<string, number>;
};

export type GrenadePreview = {
  id: number;
  map: string;
  side: 'T' | 'CT' | 'Any' | string;
  grenade_type: 'smoke' | 'flash' | 'molotov' | 'HE' | string;
  is_core: boolean;
  throw_description?: string | null;
  coordinates?: string | null;
  thrower?: string | null;
  thrower_team?: string | null;
  airtime?: number | null;
  usage_count: number;
  start_map_x?: number | null;
  start_map_y?: number | null;
  explode_map_x?: number | null;
  explode_map_y?: number | null;
  explode_pos_z?: number | null;
  explode_radar_level: 'default' | 'lower' | 'unknown' | string;
  trajectory_preview?: Array<[number, number]> | null;
};

export type ViewedGrenade = GrenadePreview & {
  viewed_at: string;
  view_count: number;
};

export type GrenadeDetail = GrenadePreview & {
  usage_throwers: string[];
  demo_filename?: string | null;
  throw_tick?: number | null;
  lineup_tick?: number | null;
  tickrate?: number | null;
  round_time_seconds?: number | null;
  start_pos_x?: number | null;
  start_pos_y?: number | null;
  start_pos_z?: number | null;
  explode_pos_x?: number | null;
  explode_pos_y?: number | null;
  map_image_path?: string | null;
  preview_image_path?: string | null;
};

export type SpawnPoint = {
  map: string;
  side: 'T' | 'CT' | string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  map_x?: number | null;
  map_y?: number | null;
  command: string;
};
