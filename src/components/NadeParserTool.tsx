import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Database,
  Download,
  FileArchive,
  FileJson,
  FilePlus2,
  Fingerprint,
  FolderOpen,
  FolderPlus,
  Gauge,
  Layers,
  Package,
  Play,
  RefreshCw,
  Square,
  ShieldCheck,
  Timer,
  Trash2,
  XCircle,
} from 'lucide-react';
import { importJson } from '../lib/tauri';
import { useI18n } from '../i18n';
import DestructiveConfirmDialog from './DestructiveConfirmDialog';
import WorkersSelect from './WorkersSelect';

type Props = { refreshImports?: () => Promise<void> };
type Status = {
  running: boolean;
  stage: string;
  output?: string;
  error?: string;
  completed: number;
  total: number;
  current?: string;
  elapsed_ms: number;
  workers: number;
};

function formatDuration(milliseconds: number) {
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function NadeParserTool({ refreshImports }: Props) {
  const { tr } = useI18n();
  const [installed, setInstalled] = useState(false);
  const [status, setStatus] = useState<Status>({
    running: false,
    stage: 'idle',
    completed: 0,
    total: 0,
    elapsed_ms: 0,
    workers: 4,
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dedup, setDedup] = useState(false);
  const [workers, setWorkers] = useState(2);
  const [stopping, setStopping] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<'raw' | 'canonical'>('raw');
  const [counts, setCounts] = useState<[number, number]>([0, 0]);
  const [confirmation, setConfirmation] = useState<
    'uninstall' | 'clear' | null
  >(null);
  const [confirmationError, setConfirmationError] = useState('');
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmingRef = useRef(false);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    const info = await invoke<{ installed: boolean }>('get_nade_parser_info');
    setInstalled(info.installed);
    setStatus(await invoke<Status>('get_nade_parser_status'));
    setCounts(await invoke<[number, number]>('get_parser_workspace_counts'));
  };
  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    const syncPluginStatus = () => {
      if (document.visibilityState !== 'visible') return;
      refresh().catch((e) => setError(String(e)));
    };
    window.addEventListener('focus', syncPluginStatus);
    document.addEventListener('visibilitychange', syncPluginStatus);
    return () => {
      window.removeEventListener('focus', syncPluginStatus);
      document.removeEventListener('visibilitychange', syncPluginStatus);
    };
  }, []);
  useEffect(() => {
    if (!status.running) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const nextStatus = await invoke<Status>('get_nade_parser_status');
        if (!active) return;
        setStatus(nextStatus);
        if (!nextStatus.running) setStopping(false);
        if (nextStatus.running) {
          timer = window.setTimeout(poll, 500);
          return;
        }
        try {
          const nextCounts = await invoke<[number, number]>(
            'get_parser_workspace_counts',
          );
          if (active) setCounts(nextCounts);
        } catch (e) {
          if (active) setError(String(e));
        }
      } catch (e) {
        if (!active) return;
        setError(String(e));
        timer = window.setTimeout(poll, 1000);
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [status.running]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || status.running || confirmBusy;
  const openConfirmation = (kind: 'uninstall' | 'clear') => {
    if (locked) return;
    setConfirmationError('');
    setConfirmation(kind);
  };
  const closeConfirmation = () => {
    if (!confirmingRef.current) setConfirmation(null);
  };
  const confirmDestructiveAction = async () => {
    if (!confirmation || locked || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirmBusy(true);
    setConfirmationError('');
    setError('');
    setMessage('');
    try {
      await invoke(
        confirmation === 'uninstall'
          ? 'uninstall_nade_parser'
          : 'clear_parser_workspace',
      );
      // Commit the successful action before refreshing so a refresh failure never invites a retry.
      if (confirmation === 'uninstall') setInstalled(false);
      else {
        setCounts([0, 0]);
        setSource('raw');
      }
      setMessage(
        confirmation === 'uninstall'
          ? tr('Plugin removed.', 'Плагин удалён.')
          : tr('Parser database cleared.', 'База данных парсера очищена.'),
      );
      try {
        await refresh();
      } catch (e) {
        setError(String(e));
      }
      setConfirmation(null);
    } catch (e) {
      setConfirmationError(String(e));
    } finally {
      confirmingRef.current = false;
      setConfirmBusy(false);
    }
  };
  const stages: Record<string, string> = {
    idle: tr('Ready', 'Готово'),
    scanning: tr('Scanning folders...', 'Поиск демо в папках...'),
    parsing: tr('Parsing demos', 'Разбор демо'),
    deduplicating: tr('Deduplicating throws...', 'Дедупликация бросков...'),
    finalizing: tr(
      'Writing combined result...',
      'Сохранение общего результата...',
    ),
    complete: tr('Complete', 'Завершено'),
    cancelling: tr('Stopping parser...', 'Остановка парсера...'),
    cancelled: tr('Parsing stopped', 'Парсинг остановлен'),
    failed: tr(
      'Job failed. No new result was published.',
      'Задача завершилась ошибкой. Новый результат не сохранён.',
    ),
  };
  const progress = status.total
    ? Math.round((status.completed / status.total) * 100)
    : 0;
  return (
    <section className="tools-plugin-view" aria-label="Nade Parser">
      <div className="tools-header">
        <div>
          <span className="tools-kicker">
            {tr('Demo analysis', 'Анализ демо')}
          </span>
          <h1>Nade Parser</h1>
          <p>
            {tr(
              'Turn demos into a clean, reviewable lineup library.',
              'Превратите демо в чистую библиотеку раскидок.',
            )}
          </p>
        </div>
        <div className="tools-plugin-controls">
          <div className={`tools-health ${installed ? 'ok' : 'warn'}`}>
            {installed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <span>
              {installed
                ? tr('Plugin ready', 'Плагин готов')
                : tr('Plugin required', 'Нужен плагин')}
            </span>
          </div>
          <button
            ref={installButtonRef}
            className={`btn ${installed ? '' : 'primary'}`}
            disabled={locked}
            onClick={() =>
              void action(async () => {
                await invoke('install_nade_parser');
                await refresh();
                setMessage(
                  tr(
                    installed ? 'Plugin reinstalled.' : 'Plugin installed.',
                    installed ? 'Плагин переустановлен.' : 'Плагин установлен.',
                  ),
                );
              })
            }
          >
            <RefreshCw size={14} />
            {installed
              ? tr('Reinstall plugin', 'Переустановить плагин')
              : tr('Install plugin', 'Установить плагин')}
          </button>
          {installed && (
            <button
              className="btn danger-action"
              disabled={locked}
              onClick={() => openConfirmation('uninstall')}
            >
              <Trash2 size={14} />
              {tr('Remove plugin', 'Удалить плагин')}
            </button>
          )}
        </div>
      </div>
      {(error || (installed && status.error) || message) && (
        <div className="tools-feedback">
          {(error || (installed && status.error)) && (
            <div className="tools-error" role="alert">
              <XCircle size={16} />
              <span>{error || status.error}</span>
            </div>
          )}
          {message && (
            <p className="tools-message" role="status">
              {message}
            </p>
          )}
        </div>
      )}
      {installed && (
        <div className="tools-grid">
          <div className="tools-card tools-input">
            <div className="tools-card-title">
              <FolderOpen size={18} />
              <div>
                <strong>{tr('Input sources', 'Источники')}</strong>
                <small>
                  {tr(
                    'One demo or many folders',
                    'Одно демо или несколько папок',
                  )}
                </small>
              </div>
            </div>
            <div className="tools-actions">
              <button
                className="btn"
                disabled={locked}
                onClick={() =>
                  void action(async () => {
                    const p = await invoke<string[]>('select_demo_files');
                    setPaths((old) => [...new Set([...old, ...p])]);
                  })
                }
              >
                <FilePlus2 size={16} aria-hidden="true" />
                {tr('Add demo files', 'Добавить файлы демо')}
              </button>
              <button
                className="btn"
                disabled={locked}
                onClick={() =>
                  void action(async () => {
                    const p = await invoke<string[]>('select_demo_folders');
                    setPaths((old) => [...new Set([...old, ...p])]);
                  })
                }
              >
                <FolderPlus size={16} aria-hidden="true" />
                {tr('Add folders', 'Добавить папки')}
              </button>
            </div>
            {paths.length > 0 ? (
              <ul
                className="tools-paths"
                aria-label={tr('Selected paths', 'Выбранные пути')}
              >
                {paths.map((path) => (
                  <li key={path}>
                    <span title={path}>{path}</span>
                    <button
                      disabled={locked}
                      aria-label={`${tr('Remove', 'Удалить')}: ${path}`}
                      onClick={() =>
                        setPaths((old) => old.filter((p) => p !== path))
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="tools-empty">
                <FolderOpen size={20} />
                <span>
                  {tr('No sources selected yet', 'Источники ещё не выбраны')}
                </span>
              </div>
            )}
            <div className="tools-parser-options">
              <div className="tools-workers">
                <span>
                  <b>{tr('Parallel workers', 'Параллельные воркеры')}</b>
                  <small>
                    {tr(
                      'Use fewer workers for HDD or constrained storage.',
                      'Для HDD или медленного диска используйте меньше воркеров.',
                    )}
                  </small>
                </span>
                <WorkersSelect
                  value={workers}
                  disabled={locked}
                  onChange={setWorkers}
                />
              </div>
              <label className={`tools-check ${dedup ? 'is-on' : ''}`}>
                <span className="tools-check-copy">
                  <b>
                    {tr('Build canonical set', 'Создать канонический набор')}
                  </b>
                  <small>
                    {tr(
                      'Keep raw throws available for later recomputation.',
                      'Исходные броски сохранятся для повторной обработки.',
                    )}
                  </small>
                </span>
                <span className="tools-check-switch">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={dedup}
                    onChange={(e) => setDedup(e.target.checked)}
                  />
                  <span className="tools-check-knob">
                    <Check size={11} strokeWidth={3} aria-hidden="true" />
                  </span>
                </span>
              </label>
            </div>
            {status.running ? (
              <button
                className="btn danger-action tools-run"
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  setError('');
                  void invoke('stop_nade_parser').catch((e) => {
                    setStopping(false);
                    setError(String(e));
                  });
                }}
              >
                <Square size={15} />
                {stopping
                  ? tr('Stopping...', 'Останавливаем...')
                  : tr('Stop parsing', 'Остановить парсинг')}
              </button>
            ) : (
              <button
                className="btn primary tools-run"
                disabled={locked || !installed || !paths.length}
                onClick={() =>
                  void action(async () => {
                    await invoke('run_nade_parser_batch', {
                      paths,
                      deduplicate: dedup,
                      workers,
                    });
                    const nextStatus = await invoke<Status>(
                      'get_nade_parser_status',
                    );
                    setStatus(nextStatus);
                    if (!nextStatus.running) {
                      setCounts(
                        await invoke<[number, number]>(
                          'get_parser_workspace_counts',
                        ),
                      );
                    }
                  })
                }
              >
                <Play size={15} />
                {tr('Start parsing', 'Начать парсинг')}
              </button>
            )}
          </div>
          <div className="tools-card tools-status">
            <div className="tools-card-title">
              <Gauge size={18} />
              <div>
                <strong>{tr('Live processing', 'Текущая обработка')}</strong>
                <small>{stages[status.stage] || status.stage}</small>
              </div>
            </div>
            <div className="tools-progress">
              <div className="tools-progress-meta">
                <b>{progress}%</b>
                <span>
                  {status.total
                    ? `${status.completed} / ${status.total} ${tr('demos', 'демо')}`
                    : status.running
                      ? tr('Processing workspace', 'Обработка рабочей базы')
                      : tr('Waiting for a run', 'Ожидание запуска')}
                </span>
              </div>
              <div className="progress-shell">
                <div
                  className="progress-bar"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            {status.stage !== 'idle' && (
              <div className="tools-runtime" aria-live="polite">
                <Timer size={16} aria-hidden="true" />
                <span>
                  {status.running
                    ? tr('Elapsed', 'Прошло')
                    : status.stage === 'failed'
                      ? tr('Failed after', 'Ошибка через')
                      : status.stage === 'cancelled'
                        ? tr('Stopped after', 'Остановлено через')
                        : tr('Completed in', 'Выполнено за')}
                </span>
                <strong>{formatDuration(status.elapsed_ms)}</strong>
              </div>
            )}
            {status.running && status.workers > 0 && (
              <div className="tools-worker-status">
                <span>{tr('Active worker limit', 'Лимит воркеров')}</span>
                <b>{status.workers}</b>
              </div>
            )}
            <div className="tools-current" role="status">
              <span>
                {status.current
                  ? tr('Current file', 'Текущий файл')
                  : tr('Status', 'Статус')}
              </span>
              <strong>
                {status.current || stages[status.stage] || status.stage}
              </strong>
            </div>
            <div className="tools-stats">
              <div>
                <Database size={15} />
                <b>{counts[0].toLocaleString()}</b>
                <span>{tr('raw throws', 'исходных бросков')}</span>
              </div>
              <div>
                <Package size={15} />
                <b>{counts[1].toLocaleString()}</b>
                <span>{tr('demos indexed', 'демо в базе')}</span>
              </div>
            </div>
            <div className="tools-workspace-actions">
              <div>
                <strong>
                  {tr('Parser workspace', 'Рабочая база парсера')}
                </strong>
                <small>
                  {tr(
                    'Remove parsed demos and the canonical set. Viewer libraries stay intact.',
                    'Удалить обработанные демо и канонический набор. Библиотеки Viewer не затрагиваются.',
                  )}
                </small>
              </div>
              <button
                className="btn danger-action"
                disabled={locked || !counts[0]}
                onClick={() => openConfirmation('clear')}
              >
                <Trash2 size={14} />
                {tr('Clear parser database', 'Очистить базу парсера')}
              </button>
            </div>
          </div>
          <div className="tools-card tools-output">
            <div className="tools-card-title">
              <ShieldCheck size={18} />
              <div>
                <strong>{tr('Review and export', 'Проверка и экспорт')}</strong>
                <small>
                  {tr(
                    'Nothing is imported automatically',
                    'Автоматический импорт отключён',
                  )}
                </small>
              </div>
            </div>
            <fieldset className="tools-dataset" disabled={locked}>
              <legend>{tr('Dataset', 'Набор данных')}</legend>
              <div className="tools-dataset-options">
                <label>
                  <input
                    type="radio"
                    name="parser-source"
                    value="raw"
                    checked={source === 'raw'}
                    onChange={() => setSource('raw')}
                  />
                  <span className="tools-dataset-icon" aria-hidden="true">
                    <Layers size={15} />
                  </span>
                  <span className="tools-dataset-copy">
                    <strong>{tr('All throws', 'Все броски')}</strong>
                    <small>
                      {tr(
                        'Every parsed throw as-is',
                        'Каждый разобранный бросок как есть',
                      )}
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="parser-source"
                    value="canonical"
                    checked={source === 'canonical'}
                    onChange={() => setSource('canonical')}
                  />
                  <span className="tools-dataset-icon" aria-hidden="true">
                    <Fingerprint size={15} />
                  </span>
                  <span className="tools-dataset-copy">
                    <strong>{tr('Deduplicated', 'Без повторов')}</strong>
                    <small>
                      {tr(
                        'Similar throws merged into one',
                        'Похожие броски объединены в один',
                      )}
                    </small>
                  </span>
                </label>
              </div>
            </fieldset>
            <div className="tools-actions tools-export-actions">
              <button
                className="btn"
                disabled={locked}
                onClick={() =>
                  void action(async () => {
                    await invoke('deduplicate_parser_workspace');
                    const nextStatus = await invoke<Status>(
                      'get_nade_parser_status',
                    );
                    setStatus(nextStatus);
                    if (!nextStatus.running) {
                      setCounts(
                        await invoke<[number, number]>(
                          'get_parser_workspace_counts',
                        ),
                      );
                    }
                  })
                }
              >
                <RefreshCw size={14} />
                {tr('Recompute', 'Пересчитать')}
              </button>
              <div
                className="tools-export-formats"
                role="group"
                aria-label={tr('Export format', 'Формат экспорта')}
              >
                <button
                  className="btn tools-format-btn"
                  aria-label={tr('Export JSON', 'Экспорт JSON')}
                  disabled={locked}
                  onClick={() =>
                    void action(async () => {
                      const p = await invoke<string | null>(
                        'save_parser_output',
                        {
                          source,
                          format: 'json',
                        },
                      );
                      if (p) setMessage(`${tr('Saved', 'Сохранено')}: ${p}`);
                    })
                  }
                >
                  <FileJson size={14} />
                  JSON
                </button>
                <button
                  className="btn tools-format-btn"
                  aria-label={tr('Export MPK', 'Экспорт MPK')}
                  disabled={locked}
                  onClick={() =>
                    void action(async () => {
                      const p = await invoke<string | null>(
                        'save_parser_output',
                        {
                          source,
                          format: 'msgpack',
                        },
                      );
                      if (p) setMessage(`${tr('Saved', 'Сохранено')}: ${p}`);
                    })
                  }
                >
                  <FileArchive size={16} aria-hidden="true" />
                  MPK
                </button>
              </div>
            </div>
            <button
              className="btn primary tools-import"
              disabled={locked || !counts[0]}
              onClick={() =>
                void action(async () => {
                  const p = await invoke<string>('prepare_parser_import', {
                    source,
                  });
                  await importJson(p);
                  await refreshImports?.();
                  setMessage(
                    tr('Imported into Viewer', 'Импортировано в Viewer'),
                  );
                })
              }
            >
              <Download size={16} aria-hidden="true" />
              {tr(
                'Import selected dataset into Viewer',
                'Импортировать выбранный набор',
              )}
            </button>
          </div>
        </div>
      )}
      {confirmation && (
        <DestructiveConfirmDialog
          eyebrow={
            confirmation === 'uninstall'
              ? tr('Remove plugin', 'Удаление плагина')
              : tr('Clear database', 'Очистка базы данных')
          }
          title={
            confirmation === 'uninstall'
              ? 'Nade Parser'
              : tr('Parser workspace', 'Рабочая база парсера')
          }
          description={
            confirmation === 'uninstall'
              ? tr(
                  'Parsing will be unavailable until you install the plugin again. Your parser data and Viewer libraries will be preserved.',
                  'Парсинг будет недоступен до повторной установки плагина. Данные парсера и библиотеки Viewer сохранятся.',
                )
              : tr(
                  'Raw throws, indexed demos and the canonical set will be permanently removed. Imported Viewer libraries will be preserved.',
                  'Исходные броски, обработанные демо и канонический набор будут удалены без возможности восстановления. Импортированные библиотеки Viewer сохранятся.',
                )
          }
          metadata={
            confirmation === 'uninstall' ? (
              <>
                <span>{tr('Plugin', 'Плагин')}</span>
                <strong>Nade Parser</strong>
                <span>{tr('Data and libraries', 'Данные и библиотеки')}</span>
                <strong>{tr('Preserved', 'Сохранятся')}</strong>
              </>
            ) : (
              <>
                <span>{tr('Raw throws', 'Исходные броски')}</span>
                <strong>{counts[0].toLocaleString()}</strong>
                <span>{tr('Indexed demos', 'Демо в базе')}</span>
                <strong>{counts[1].toLocaleString()}</strong>
              </>
            )
          }
          confirmLabel={
            confirmation === 'uninstall'
              ? tr('Remove plugin', 'Удалить плагин')
              : tr('Clear database', 'Очистить базу')
          }
          pendingLabel={
            confirmation === 'uninstall'
              ? tr('Removing...', 'Удаление...')
              : tr('Clearing...', 'Очистка...')
          }
          busy={confirmBusy}
          error={confirmationError}
          onCancel={closeConfirmation}
          onConfirm={() => void confirmDestructiveAction()}
          fallbackFocusRef={installButtonRef}
        />
      )}
    </section>
  );
}
