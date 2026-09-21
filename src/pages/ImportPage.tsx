import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileJson,
  FolderOpen,
  History,
  Info,
  Map,
  RotateCw,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  cancelImport,
  getImportStatus,
  importJson,
  isTauri,
  selectImportFile,
} from '../lib/tauri';
import { compactDate, formatNumber } from '../lib/format';
import {
  IMPORT_STATUS_IDLE,
  importProgressPercent,
  isImportFailure,
} from '../lib/importStatus';
import {
  importErrorCode,
  importErrorDetail,
  importErrorLabel,
  importStatusMessage,
} from '../lib/importMessages';
import { useImportStatusPolling } from '../lib/useImportStatusPolling';
import type {
  ImportStatus,
  ImportSummary,
  JsonImportReport,
} from '../types/domain';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';

type Props = {
  onImported: () => Promise<void>;
  lastImport: ImportSummary | null;
  onImportStateChange: (state: 'idle' | 'importing' | 'complete') => void;
};

/** Inline outcome shown under the drop zone after a run settles. */
type ImportOutcome = {
  tone: 'error' | 'cancelled' | 'info';
  title: string;
  detail?: string;
};

function sourceFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export default function ImportPage({
  onImported,
  lastImport,
  onImportStateChange,
}: Props) {
  const { locale, tr, count } = useI18n();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const [status, setStatus] = useState<ImportStatus>(IMPORT_STATUS_IDLE);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [completion, setCompletion] = useState<JsonImportReport | null>(null);
  const busyRef = useRef(false);
  const runTokenRef = useRef(0);
  const runHandledRef = useRef(false);
  const runImportRef = useRef<(nextPath?: string) => Promise<void>>(
    async () => undefined,
  );
  const progress = useMemo(
    () => Math.round(importProgressPercent(status, busy ? 8 : 0)),
    [busy, status],
  );
  const progressText = tr(`${progress}% complete`, `Выполнено ${progress}%`);
  const busyLabel =
    importStatusMessage(status, tr) ?? tr('Importing…', 'Импорт…');

  const handleTerminalFailure = useCallback(
    (terminal: ImportStatus) => {
      if (runHandledRef.current) return;
      runHandledRef.current = true;
      if (terminal.stage === 'cancelled') {
        setOutcome({
          tone: 'cancelled',
          title: tr('Import cancelled', 'Импорт отменён'),
        });
        showToast(tr('Import cancelled', 'Импорт отменён'), {
          tone: 'info',
          duration: 4600,
        });
      } else {
        const detail = terminal.error?.trim() || undefined;
        const title = detail
          ? tr('Import failed', 'Ошибка импорта')
          : (importStatusMessage(terminal, tr) ??
            tr('Import failed', 'Ошибка импорта'));
        setOutcome({ tone: 'error', title, detail });
        showToast(detail ? `${title}: ${detail}` : title, {
          tone: 'error',
          duration: 4600,
        });
      }
      busyRef.current = false;
      setBusy(false);
      setCancelling(false);
      onImportStateChange('idle');
    },
    [onImportStateChange, showToast, tr],
  );

  useImportStatusPolling({
    enabled: busy,
    onStatus: setStatus,
    onTerminal: (terminal) => {
      if (terminal.stage === 'done') return;
      if (isImportFailure(terminal)) handleTerminalFailure(terminal);
    },
    onError: (error) => {
      console.error('Unable to read import progress', error);
      setStatus((current) => ({
        ...current,
        message: tr(
          'Unable to read import progress',
          'Не удалось получить ход импорта',
        ),
      }));
    },
  });

  const choose = async () => {
    try {
      const selected = await selectImportFile();
      if (!selected) return;
      setPath(selected);
      await runImportRef.current(selected);
    } catch (error) {
      console.error(error);
      const title = tr(
        'Unable to open the file picker',
        'Не удалось открыть выбор файла',
      );
      setOutcome({ tone: 'error', title });
      showToast(title, { tone: 'error' });
    }
  };

  const runImport = async (nextPath = path) => {
    const trimmed = nextPath.trim();
    if (!trimmed || busyRef.current) return;
    const token = ++runTokenRef.current;
    busyRef.current = true;
    runHandledRef.current = false;
    setBusy(true);
    onImportStateChange('importing');
    setCancelling(false);
    setCompletion(null);
    setOutcome(null);
    try {
      const report = await importJson(trimmed);
      if (token !== runTokenRef.current) return;
      setStatus(await getImportStatus());
      await onImported();
      if (report.kind === 'core_nades') {
        showToast(
          tr(
            `Imported ${formatNumber(report.grenade_count)} Core Nades snapshot`,
            `Импортирован снимок Core Nades: ${formatNumber(report.grenade_count)} гранат`,
          ),
          { tone: 'success', duration: 1960 },
        );
      } else if (report.kind === 'screenshot_archive') {
        showToast(
          tr(
            `Imported ${formatNumber(report.grenade_count)} lineups and ${formatNumber(report.screenshot_count)} screenshots`,
            `Импортировано ${formatNumber(report.grenade_count)} раскидок и ${formatNumber(report.screenshot_count)} скриншотов`,
          ),
          { tone: 'success', duration: 1960 },
        );
      } else {
        showToast(
          tr(
            `Imported ${formatNumber(report.grenade_count)} lineups`,
            `Импортировано ${formatNumber(report.grenade_count)} раскидок`,
          ),
          { tone: 'success', duration: 1960 },
        );
      }
      flushSync(() => {
        setCompletion(report);
        onImportStateChange('complete');
      });
    } catch (error) {
      // A newer run started, or the polling loop already reported this outcome.
      if (token !== runTokenRef.current || runHandledRef.current) return;
      runHandledRef.current = true;
      const code = importErrorCode(error);
      if (code === 'import_cancelled') {
        onImportStateChange('idle');
        setOutcome({
          tone: 'cancelled',
          title: tr('Import cancelled', 'Импорт отменён'),
        });
        showToast(tr('Import cancelled', 'Импорт отменён'), {
          tone: 'info',
          duration: 4600,
        });
        return;
      }
      const title =
        importErrorLabel(code, tr) ?? tr('Import failed', 'Ошибка импорта');
      const detail = importErrorDetail(error)?.trim() || undefined;
      onImportStateChange('idle');
      setOutcome({ tone: 'error', title, detail });
      showToast(detail ? `${title}: ${detail}` : title, {
        tone: 'error',
        duration: 4600,
      });
    } finally {
      if (token === runTokenRef.current) {
        busyRef.current = false;
        setBusy(false);
        setCancelling(false);
      }
    }
  };
  runImportRef.current = runImport;

  const startAnotherImport = () => {
    setCompletion(null);
    setOutcome(null);
    setPath('');
    setStatus(IMPORT_STATUS_IDLE);
    onImportStateChange('idle');
  };

  const cancelRun = async () => {
    if (!busyRef.current || cancelling) return;
    const token = runTokenRef.current;
    setCancelling(true);
    try {
      const accepted = await cancelImport();
      // The run may have already finished (or a new one started) meanwhile.
      if (!accepted || token !== runTokenRef.current || !busyRef.current) {
        setCancelling(false);
      }
    } catch (error) {
      console.error('Unable to cancel the import', error);
      setCancelling(false);
      showToast(
        tr('Could not cancel the import', 'Не удалось отменить импорт'),
        { tone: 'error' },
      );
    }
  };

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter' || payload.type === 'over') {
          setDragging(true);
        } else if (payload.type === 'leave') {
          setDragging(false);
        } else {
          setDragging(false);
          const droppedPath = payload.paths.find((candidate) =>
            /\.(json|messagepack|msgpack|mpk|zip)$/i.test(candidate),
          );
          if (droppedPath) {
            setPath(droppedPath);
            runImportRef.current(droppedPath).catch((error) => {
              console.error('Unable to import dropped file', error);
              const title = tr('Import failed', 'Ошибка импорта');
              setOutcome({ tone: 'error', title });
              showToast(title, { tone: 'error' });
            });
          } else {
            const title = tr(
              'Drop a JSON, MessagePack, or Nadegrid ZIP file',
              'Перетащите JSON-, MessagePack- или ZIP-файл Nadegrid',
            );
            setOutcome({ tone: 'info', title });
            showToast(title, { tone: 'info' });
          }
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        console.error('Unable to listen for file drops', error);
        const title = tr(
          'File drop is unavailable',
          'Перетаскивание файлов недоступно',
        );
        setOutcome({ tone: 'error', title });
        showToast(title, { tone: 'error' });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [locale, showToast]);

  return (
    <div className="import-view">
      <section className="import-panel">
        <div className="import-copy">
          <div className="import-orbit">
            <FileJson size={32} />
          </div>
          <div className="eyebrow">
            {tr('Library setup', 'Настройка библиотеки')}
          </div>
          <h1>{tr('Bring your lineups in.', 'Импортируйте раскидки.')}</h1>
          <p className="muted wide">
            {tr(
              'Load a grenade index or a curated Core Nades collection in JSON or MessagePack. Everything stays on this device.',
              'Загрузите индекс гранат или коллекцию Core Nades в JSON или MessagePack. Все данные останутся на этом устройстве.',
            )}
          </p>
          <div className="import-features">
            <span>
              <ShieldCheck size={16} />{' '}
              {tr('Local SQLite storage', 'Локальное хранилище SQLite')}
            </span>
            <span>
              <CheckCircle2 size={16} />{' '}
              {tr('Format detected automatically', 'Автоопределение формата')}
            </span>
          </div>
        </div>

        <div className="import-action-card">
          {completion ? (
            <div className="import-complete">
              <div className="import-complete-mark">
                <CheckCircle2 size={26} />
              </div>
              <div className="eyebrow">
                {tr('Import complete', 'Импорт завершён')}
              </div>
              <h2>{tr('Your library is ready', 'Библиотека готова')}</h2>
              <p className="muted">{sourceFileName(completion.source_path)}</p>
              <div className="import-complete-counts">
                <div>
                  <b>{formatNumber(completion.grenade_count)}</b>
                  <span>
                    {count(
                      completion.grenade_count,
                      'grenade',
                      'grenades',
                      'граната',
                      'гранаты',
                      'гранат',
                    ).replace(/^\d+[\s\u00a0]*/, '')}
                  </span>
                </div>
                <div>
                  <b>{formatNumber(completion.map_count)}</b>
                  <span>
                    {count(
                      completion.map_count,
                      'map',
                      'maps',
                      'карта',
                      'карты',
                      'карт',
                    ).replace(/^\d+[\s\u00a0]*/, '')}
                  </span>
                </div>
                {completion.kind === 'screenshot_archive' ? (
                  <div>
                    <b>{formatNumber(completion.screenshot_count)}</b>
                    <span>
                      {count(
                        completion.screenshot_count,
                        'screenshot',
                        'screenshots',
                        'скриншот',
                        'скриншота',
                        'скриншотов',
                      ).replace(/^\d+[\s\u00a0]*/, '')}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="import-complete-actions">
                <button
                  className="btn primary"
                  data-tour="import-view-maps"
                  onClick={() => navigate('/maps', { replace: true })}
                >
                  <Map size={17} />
                  {tr('View maps', 'К картам')}
                </button>
                <button className="btn" onClick={startAnotherImport}>
                  <Upload size={17} />
                  {tr('Import another', 'Импортировать ещё')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`drop-zone ${busy ? 'working' : ''} ${dragging ? 'dragging' : ''}`}
                data-tour={busy ? 'import-progress' : undefined}
              >
                <Database size={24} />
                <strong>
                  {busy
                    ? busyLabel
                    : dragging
                      ? tr(
                          'Release to import the library',
                          'Отпустите для импорта библиотеки',
                        )
                      : tr(
                          'Drop a library file here',
                          'Перетащите файл библиотеки сюда',
                        )}
                </strong>
                <span>
                  {busy
                    ? progressText
                    : tr(
                        'grenade_index.json, Core Nades JSON/MessagePack, or Nadegrid Screenshot ZIP',
                        'grenade_index.json, JSON/MessagePack Core Nades или ZIP скриншотов Nadegrid',
                      )}
                </span>
              </div>

              {busy ? (
                <div
                  className="progress-shell"
                  role="progressbar"
                  aria-label={tr('Import progress', 'Ход импорта')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  aria-valuetext={progressText}
                >
                  <div
                    className="progress-bar"
                    style={{ width: `${Math.max(progress, 6)}%` }}
                  />
                </div>
              ) : null}

              <div className="sr-only" role="status" aria-live="polite">
                {busy ? busyLabel : ''}
              </div>

              {busy ? (
                <div className="import-cancel-row">
                  <button
                    className={`btn danger-action import-cancel ${cancelling ? 'is-cancelling' : ''}`}
                    onClick={cancelRun}
                    disabled={cancelling}
                  >
                    <X size={17} />
                    {cancelling
                      ? tr('Cancelling…', 'Отмена…')
                      : tr('Cancel import', 'Отменить импорт')}
                  </button>
                </div>
              ) : null}

              {outcome ? (
                <div
                  className={`import-inline-status ${outcome.tone}`}
                  role={outcome.tone === 'error' ? 'alert' : 'status'}
                >
                  <span className="import-inline-icon" aria-hidden="true">
                    {outcome.tone === 'error' ? (
                      <AlertTriangle size={16} />
                    ) : outcome.tone === 'cancelled' ? (
                      <X size={16} />
                    ) : (
                      <Info size={16} />
                    )}
                  </span>
                  <div className="import-inline-copy">
                    <strong>{outcome.title}</strong>
                    {outcome.detail ? <span>{outcome.detail}</span> : null}
                  </div>
                  {outcome.tone === 'error' && path.trim() && !busy ? (
                    <button
                      className="btn import-inline-retry"
                      onClick={() => runImport()}
                    >
                      <RotateCw size={15} />
                      {tr('Retry', 'Повторить')}
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="file-picker-row">
                <button
                  className="btn primary"
                  data-tour="import-choose-file"
                  onClick={choose}
                  disabled={busy}
                >
                  <FolderOpen size={17} />
                  {tr('Choose file', 'Выбрать файл')}
                </button>
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={tr(
                    'Path to JSON or MessagePack file',
                    'Путь к JSON- или MessagePack-файлу',
                  )}
                  disabled={busy}
                />
                <button
                  className="btn"
                  onClick={() => runImport()}
                  disabled={busy || !path.trim()}
                >
                  <Upload size={17} />
                  {tr('Import', 'Импорт')}
                </button>
              </div>

              {lastImport ? (
                <button
                  className="last-import"
                  onClick={() => setPath(lastImport.source_path)}
                  disabled={busy}
                >
                  <History size={15} />
                  <span>{tr('Use recent source', 'Недавний источник')}</span>
                  <strong>
                    {formatNumber(lastImport.grenade_count)}{' '}
                    {tr('lineups', 'раскидок')}
                  </strong>
                  <small>{compactDate(lastImport.imported_at)}</small>
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
