import { invoke } from '@tauri-apps/api/core';

export type DemoEvent = {
  id: number;
  url: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  prize: number | null;
  player_share: number | null;
  club_share: number | null;
  teams: string;
  kind: string;
  location: string;
  status: string;
};
export type DemoJob = {
  id: string;
  url: string;
  name: string;
  status: string;
  error: string | null;
  files: string[];
};
export type CatalogQuery = {
  start: string | null;
  end: string | null;
  min_prize: number | null;
  max_prize: number | null;
};
export type DownloaderSnapshot = {
  events: DemoEvent[];
  jobs: DemoJob[];
  updated_at: number | null;
  destination: string;
  phase: string;
  current: string;
  bytes: number;
  error: string | null;
  catalog_complete: boolean;
  query: CatalogQuery;
};
export const emptyQuery: CatalogQuery = {
  start: null,
  end: null,
  min_prize: null,
  max_prize: null,
};
export const emptyDownloader: DownloaderSnapshot = {
  events: [],
  jobs: [],
  updated_at: null,
  destination: '',
  phase: 'idle',
  current: '',
  bytes: 0,
  error: null,
  catalog_complete: false,
  query: emptyQuery,
};
export const getDownloader = () =>
  invoke<DownloaderSnapshot>('get_demo_downloader');
export const refreshDemoCatalog = (query: CatalogQuery) =>
  invoke<void>('refresh_demo_catalog', { query });
export const startDemoDownloads = (urls: string[], destination: string) =>
  invoke<void>('start_demo_downloads', { urls, destination });
export const stopDemoDownloads = () => invoke<void>('stop_demo_downloads');
export const showHltvBrowser = () => invoke<void>('show_hltv_browser');
export const selectDemoDestination = () =>
  invoke<string | null>('select_demo_destination');
export const clearDemoQueue = () => invoke<void>('clear_demo_queue');
export const downloaderBusy = (phase: string) =>
  !['idle', 'failed', 'stopped', ''].includes(phase);

export function filterDemoEvents(
  events: DemoEvent[],
  filters: {
    search: string;
    kind: string;
    status: string;
    min: string;
    max: string;
    start: string;
    end: string;
  },
) {
  return events.filter((event) => {
    const lower = filters.search.trim().toLowerCase();
    if (
      lower &&
      !`${event.name} ${event.location}`.toLowerCase().includes(lower)
    )
      return false;
    if (filters.status && event.status !== filters.status) return false;
    if (filters.kind === 'large') {
      if (
        event.kind !== 'Major' &&
        !(event.kind === 'Intl. LAN' && (event.prize ?? 0) >= 250_000)
      )
        return false;
    } else if (filters.kind && event.kind !== filters.kind) return false;
    if (
      filters.min &&
      (event.prize === null || event.prize < Number(filters.min))
    )
      return false;
    if (
      filters.max &&
      (event.prize === null || event.prize > Number(filters.max))
    )
      return false;
    // Dates explicitly refer to the tournament's final day.
    if (filters.start && (!event.end_date || event.end_date < filters.start))
      return false;
    if (filters.end && (!event.end_date || event.end_date > filters.end))
      return false;
    return true;
  });
}
