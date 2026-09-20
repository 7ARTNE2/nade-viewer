import type { ImportStatus } from '../types/domain';

/**
 * Stages that mean the backend import loop has stopped. Mirrors the backend
 * `set_status` contract: `running` is false for these stages.
 */
export const IMPORT_TERMINAL_STAGES = [
  'done',
  'error',
  'cancelled',
  'idle',
] as const;

export const IMPORT_STATUS_IDLE: ImportStatus = {
  running: false,
  stage: 'idle',
  current: 0,
  total: 0,
  message: 'Ready',
  phase_current: 0,
  phase_total: 0,
  error: null,
};

/** True once the backend import has reached a stable, non-running state. */
export function isTerminalImportStatus(status: ImportStatus): boolean {
  return (
    status.error != null ||
    !status.running ||
    (IMPORT_TERMINAL_STAGES as readonly string[]).includes(status.stage)
  );
}

/** True when a terminal status represents a failure rather than a success. */
export function isImportFailure(status: ImportStatus): boolean {
  return (
    status.stage === 'error' ||
    status.stage === 'cancelled' ||
    status.error != null
  );
}

/**
 * Progress for the current phase, preferring the dedicated
 * `phase_current`/`phase_total` counters and falling back to the overall
 * `current`/`total` counters. Returns a 0..100 value (may be fractional) or the
 * provided fallback when no counters are available yet.
 */
const IMPORT_PHASE_WEIGHTS: Record<string, [number, number]> = {
  checking_update: [0, 4],
  reading: [0, 8],
  preparing: [8, 12],
  downloading: [12, 42],
  decompressing: [42, 62],
  importing: [62, 96],
  extracting_screenshots: [62, 92],
  finalizing: [92, 100],
  done: [100, 100],
  cancelled: [0, 0],
  error: [0, 0],
};

/**
 * Overall progress across the import pipeline. The backend counters describe
 * the active phase, so this maps that local progress into a stable weighted
 * range and avoids the progress bar jumping when units change from bytes to
 * rows.
 */
export function importProgressPercent(
  status: ImportStatus | null | undefined,
  fallback = 0,
): number {
  if (!status) return fallback;
  const phaseTotal = status.phase_total > 0 ? status.phase_total : status.total;
  const phaseCurrent =
    status.phase_total > 0 ? status.phase_current : status.current;
  const phaseProgress =
    phaseTotal > 0 ? Math.min(1, Math.max(0, phaseCurrent / phaseTotal)) : 0;
  const range = IMPORT_PHASE_WEIGHTS[status.stage];
  if (range)
    return Math.round(range[0] + (range[1] - range[0]) * phaseProgress);
  if (phaseTotal > 0) return Math.round(phaseProgress * 100);
  return fallback;
}
