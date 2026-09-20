import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { IMPORT_STATUS_EVENT, getImportStatus, isTauri } from './tauri';
import { isTerminalImportStatus } from './importStatus';
import type { ImportStatus } from '../types/domain';

type UseImportStatusPollingOptions = {
  /** Subscriptions run only while this is true. */
  enabled: boolean;
  /** Delay between fallback polls in milliseconds. */
  intervalMs?: number;
  /** Called with every status snapshot, from either the event or the poll. */
  onStatus?: (status: ImportStatus) => void;
  /** Called once when a terminal status is observed; polling then stops. */
  onTerminal?: (status: ImportStatus) => void;
  /** Called when reading the status fails; polling continues. */
  onError?: (error: unknown) => void;
};

/**
 * Streams import progress, preferring backend `import-status` events.
 *
 * The event subscription is the primary source. A single non-overlapping poll
 * loop provides the initial recovery read (a run may already be in progress
 * before the listener attaches) and stays as a fallback for contexts where
 * events never arrive; it stops as soon as an event is observed, so the two
 * sources never overlap. Handlers are read through a ref, so changing them does
 * not restart the subscription, and terminal snapshots that arrive before the
 * run has been observed as running (stale snapshots from a previous run) are
 * ignored.
 */
export function useImportStatusPolling({
  enabled,
  intervalMs = 350,
  onStatus,
  onTerminal,
  onError,
}: UseImportStatusPollingOptions) {
  const handlersRef = useRef({ onStatus, onTerminal, onError });
  handlersRef.current = { onStatus, onTerminal, onError };

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let timer: number | undefined;
    let sawRunning = false;
    let sawEvent = false;
    let unlisten: (() => void) | undefined;

    const stopPolling = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    // Applies a snapshot and reports whether it ended the run.
    const applyStatus = (status: ImportStatus) => {
      if (status.running) sawRunning = true;
      handlersRef.current.onStatus?.(status);
      if (sawRunning && isTerminalImportStatus(status)) {
        handlersRef.current.onTerminal?.(status);
        return true;
      }
      return false;
    };

    // Primary source: the backend pushes snapshots as the run progresses.
    if (isTauri) {
      listen<ImportStatus>(IMPORT_STATUS_EVENT, ({ payload }) => {
        if (disposed) return;
        sawEvent = true;
        stopPolling();
        applyStatus(payload);
      })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch((error) => {
          if (!disposed) handlersRef.current.onError?.(error);
        });
    }

    // Fallback: one initial recovery read, then a non-overlapping poll loop
    // that bows out permanently once an event has been observed.
    const schedule = () => {
      if (disposed || sawEvent) return;
      timer = window.setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (disposed || sawEvent) return;
      try {
        const status = await getImportStatus();
        if (disposed || sawEvent) return;
        if (applyStatus(status)) return;
      } catch (error) {
        if (disposed || sawEvent) return;
        handlersRef.current.onError?.(error);
      }
      schedule();
    };

    void tick();

    return () => {
      disposed = true;
      stopPolling();
      unlisten?.();
    };
  }, [enabled, intervalMs]);
}
