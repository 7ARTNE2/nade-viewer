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
export function importProgressPercent(
  status: ImportStatus | null | undefined,
  fallback = 0,
): number {
  if (!status) return fallback;
  const hasPhase = status.phase_total > 0;
  const total = hasPhase ? status.phase_total : status.total;
  const current = hasPhase ? status.phase_current : status.current;
  if (total > 0) return Math.min(100, Math.max(0, (current / total) * 100));
  return fallback;
}
