import { useEffect, useRef } from 'react';
import { getImportStatus } from './tauri';
import { isTerminalImportStatus } from './importStatus';
import type { ImportStatus } from '../types/domain';

type UseImportStatusPollingOptions = {
  /** Polling runs only while this is true. */
  enabled: boolean;
  /** Delay between polls in milliseconds. */
  intervalMs?: number;
  /** Called with every successfully read status snapshot. */
  onStatus?: (status: ImportStatus) => void;
  /** Called once when a terminal status is observed; polling then stops. */
  onTerminal?: (status: ImportStatus) => void;
  /** Called when reading the status fails; polling continues. */
  onError?: (error: unknown) => void;
};

/**
 * Polls `get_import_status` on a single non-overlapping loop.
 *
 * A new request is only scheduled after the previous one settles, so slow
 * backend calls can never stack up. Handlers are read through a ref, so
 * changing them does not restart the loop. The loop stops on terminal statuses
 * and ignores terminal snapshots that arrive before the run has been observed
 * as running (those belong to a previous run).
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

    const schedule = () => {
      if (disposed) return;
      timer = window.setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (disposed) return;
      try {
        const status = await getImportStatus();
        if (disposed) return;
        if (status.running) sawRunning = true;
        handlersRef.current.onStatus?.(status);
        if (sawRunning && isTerminalImportStatus(status)) {
          handlersRef.current.onTerminal?.(status);
          return;
        }
      } catch (error) {
        if (disposed) return;
        handlersRef.current.onError?.(error);
      }
      schedule();
    };

    void tick();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
}
