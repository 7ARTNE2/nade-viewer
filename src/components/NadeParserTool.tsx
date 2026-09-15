import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  FileArchive,
  FileJson,
  FilePlus2,
  Fingerprint,
  FolderOpen,
  FolderPlus,
  Gauge,
  HardDrive,
  Layers,
  Package,
  Play,
  RefreshCw,
  Square,
  ShieldCheck,
  Timer,
  Trash2,
  X,
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
  disk_read_bytes_per_sec: number;
  disk_write_bytes_per_sec: number;
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

function formatDataRate(bytesPerSecond: number) {
  if (bytesPerSecond < 1024) return `${bytesPerSecond} B/s`;
  if (bytesPerSecond < 1024 ** 2) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`;
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
    disk_read_bytes_per_sec: 0,
    disk_write_bytes_per_sec: 0,
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
  const countedCompletedRef = useRef(0);
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
        if (nextStatus.running) {
          setStatus(nextStatus);
          if (nextStatus.completed !== countedCompletedRef.current) {
            countedCompletedRef.current = nextStatus.completed;
            try {
              setCounts(
                await invoke<[number, number]>('get_parser_workspace_counts'),
              );
            } catch (e) {
              if (active) setError(String(e));
            }
          }
          timer = window.setTimeout(poll, 500);
          return;
        }
        // Publishing running=false cleans up this effect. Refresh counts first
        // so the terminal response is not discarded and raw import is enabled.
        try {
          const nextCounts = await invoke<[number, number]>(
            'get_parser_workspace_counts',
          );
          if (active) setCounts(nextCounts);
          countedCompletedRef.current = nextStatus.completed;
        } catch (e) {
          if (active) setError(String(e));
        } finally {
          if (active) {
            setStatus(nextStatus);
            setStopping(false);
          }
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
    ? Math.max(
        0,
        Math.min(100, Math.round((status.completed / status.total) * 100)),
      )
    : 0;
  const indeterminate = status.running && !status.total;
  const runState = status.running
    ? 'running'
    : status.stage === 'complete'
      ? 'complete'
      : status.stage === 'failed'
        ? 'failed'
        : 'idle';
  const runLabel = status.running
    ? tr('In progress', 'В процессе')
    : status.stage === 'complete'
      ? tr('Complete', 'Завершено')
      : status.stage === 'failed'
        ? tr('Failed', 'Ошибка')
        : status.stage === 'cancelled'
          ? tr('Stopped', 'Остановлено')
          : tr('Standby', 'Ожидание');
  return (
    <section className="tools-plugin-view nade-parser" aria-label="Nade Parser">
      <header className="tools-header parser-header">
        <div>
          <span className="tools-kicker">
            {tr('Tools / Demo analysis', 'Инструменты / Анализ демо')}
          </span>
          <div className="parser-heading-row">
            <h1>Nade Parser</h1>
            <span className={`tools-health ${installed ? 'ok' : 'warn'}`}>
              {installed ? (
                <CheckCircle2 size={13} aria-hidden="true" />
              ) : (
                <Package size={13} aria-hidden="true" />
              )}
              {installed
                ? tr('Plugin ready', 'Плагин готов')
                : tr('Not installed', 'Не установлен')}
            </span>
          </div>
          <p>
            {tr(
              'From match demos to your next lineup. Parse, refine, and bring it into Viewer.',
              'От демо матча к вашей раскидке. Разберите, отберите и добавьте в Viewer.',
            )}
          </p>
        </div>
        <div className="tools-plugin-controls">
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
              className="btn parser-remove-plugin"
              disabled={locked}
              onClick={() => openConfirmation('uninstall')}
            >
              <Trash2 size={14} />
              {tr('Remove plugin', 'Удалить плагин')}
            </button>
          )}
        </div>
      </header>
      <ol
        className="parser-workflow"
        aria-label={tr('Parser workflow', 'Этапы работы')}
      >
        <li>
          <span className="parser-step-number">01</span>
          <div>
            <strong>{tr('Select sources', 'Выберите демо')}</strong>
            <small>{tr('Files or folders', 'Файлы или папки')}</small>
          </div>
          <ArrowRight size={15} aria-hidden="true" />
        </li>
        <li>
          <span className="parser-step-number">02</span>
          <div>
            <strong>{tr('Parse & refine', 'Обработайте')}</strong>
            <small>
              {tr('Extract and deduplicate', 'Броски и дедупликация')}
            </small>
          </div>
          <ArrowRight size={15} aria-hidden="true" />
        </li>
        <li>
          <span className="parser-step-number">03</span>
          <div>
            <strong>{tr('Build your library', 'Пополните библиотеку')}</strong>
            <small>
              {tr(
                'Export or import into Viewer',
                'Экспорт или импорт в Viewer',
              )}
            </small>
          </div>
          <CheckCircle2 size={15} aria-hidden="true" />
        </li>
      </ol>
      {!installed && (
        <div className="parser-install-note">
          <Package size={28} aria-hidden="true" />
          <div>
            <h2>
              {tr(
                'Your demo workspace starts here',
                'Рабочее пространство для ваших демо',
              )}
            </h2>
            <p>
              {tr(
                'Install Nade Parser using the button above to select demos and extract grenade throws. Processing runs locally on your computer.',
                'Установите Nade Parser кнопкой выше, чтобы выбрать демо и извлечь броски гранат. Обработка выполняется локально на вашем компьютере.',
              )}
            </p>
          </div>
        </div>
      )}
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
              <span className="parser-panel-icon">
                <FolderOpen size={18} aria-hidden="true" />
              </span>
              <div>
                <h2>{tr('Input sources', 'Источники')}</h2>
                <small>
                  {tr(
                    'Queue demos for your next run',
                    'Добавьте демо для следующего запуска',
                  )}
                </small>
              </div>
              <span
                className="parser-count"
                aria-label={tr('Selected sources', 'Выбрано источников')}
              >
                {paths.length}
              </span>
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
                    {path.toLowerCase().endsWith('.dem') ? (
                      <FileArchive size={17} aria-hidden="true" />
                    ) : (
                      <FolderOpen size={17} aria-hidden="true" />
                    )}
                    <div className="parser-path-copy">
                      <strong title={path}>
                        {path.split(/[\\/]/).filter(Boolean).pop() || path}
                      </strong>
                      <span title={path}>{path}</span>
                    </div>
                    <button
                      disabled={locked}
                      aria-label={`${tr('Remove', 'Удалить')}: ${path}`}
                      onClick={() =>
                        setPaths((old) => old.filter((p) => p !== path))
                      }
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="tools-empty">
                <span className="parser-empty-icon">
                  <FilePlus2 size={25} aria-hidden="true" />
                </span>
                <strong>{tr('Start with a demo', 'Начните с демо')}</strong>
                <span>
                  {tr(
                    'Choose .dem files or add an entire folder using the buttons above.',
                    'Выберите файлы .dem или добавьте папку с помощью кнопок выше.',
                  )}
                </span>
                <small>
                  {tr(
                    '.DEM FILES · BATCH PROCESSING',
                    'ФАЙЛЫ .DEM · ПАКЕТНАЯ ОБРАБОТКА',
                  )}
                </small>
              </div>
            )}
            <div className="tools-parser-options">
              <h3 className="parser-section-label">
                <Cpu size={13} aria-hidden="true" />
                {tr('Processing settings', 'Параметры обработки')}
              </h3>
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
          <div className={`tools-card tools-status is-${runState}`}>
            <div className="tools-card-title">
              <span className="parser-panel-icon">
                <Gauge size={18} aria-hidden="true" />
              </span>
              <div>
                <h2>{tr('Live processing', 'Текущая обработка')}</h2>
                <small>
                  {tr(
                    'Follow your parsing session',
                    'Следите за ходом разбора',
                  )}
                </small>
              </div>
              <span className={`parser-run-state is-${runState}`} role="status">
                <i aria-hidden="true" />
                {runLabel}
              </span>
            </div>
            <div className="tools-progress">
              <div className="parser-section-label">
                {tr('Session progress', 'Прогресс сессии')}
              </div>
              <div className="tools-progress-meta">
                <b>
                  {indeterminate ? '—' : progress}
                  <small>{indeterminate ? '' : '%'}</small>
                </b>
                <span>
                  {status.total
                    ? `${status.completed} / ${status.total} ${tr('demos', 'демо')}`
                    : status.running
                      ? tr('Processing workspace', 'Обработка рабочей базы')
                      : tr('Waiting for a run', 'Ожидание запуска')}
                </span>
              </div>
              <div
                className={`progress-shell ${indeterminate ? 'is-indeterminate' : ''}`}
                role="progressbar"
                aria-label={tr(
                  'Demo parsing progress',
                  'Прогресс разбора демо',
                )}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={indeterminate ? undefined : progress}
                aria-valuetext={
                  indeterminate
                    ? stages[status.stage] || status.stage
                    : `${progress}%`
                }
              >
                <div
                  className="progress-bar"
                  style={{ width: indeterminate ? '100%' : `${progress}%` }}
                />
              </div>
              <p className="parser-progress-caption">
                {status.stage === 'idle'
                  ? tr(
                      'Add sources and start parsing to see progress here.',
                      'Добавьте источники и запустите парсинг — прогресс появится здесь.',
                    )
                  : stages[status.stage] || status.stage}
              </p>
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
            {status.running && (
              <div className="tools-runtime parser-disk-rate">
                <HardDrive size={16} aria-hidden="true" />
                <span>{tr('Parser disk I/O', 'Диск парсера')}</span>
                <strong>
                  {tr('Read', 'Чтение')} {formatDataRate(status.disk_read_bytes_per_sec)} ·{' '}
                  {tr('Write', 'Запись')} {formatDataRate(status.disk_write_bytes_per_sec)}
                </strong>
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
            <div className="parser-workspace-summary">
              <h3 className="parser-section-label">
                {tr('Saved in workspace', 'Сохранено в базе')}
              </h3>
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
              <p className="parser-local-note">
                <ShieldCheck size={13} aria-hidden="true" />
                {tr(
                  'Stored locally. Import into Viewer when ready.',
                  'Сохранено локально. Импортируйте в Viewer, когда будете готовы.',
                )}
              </p>
            </div>
          </div>
          <div className="tools-card tools-output">
            <div className="tools-card-title">
              <span className="parser-panel-icon">
                <Download size={18} aria-hidden="true" />
              </span>
              <div>
                <h2>{tr('Review and export', 'Проверка и экспорт')}</h2>
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
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
          <footer className="tools-workspace-actions parser-maintenance">
            <Database size={18} aria-hidden="true" />
            <div>
              <strong>{tr('Parser workspace', 'Рабочая база парсера')}</strong>
              <small>
                {tr(
                  'Clears parsed demos and the canonical set. Your Viewer libraries are kept.',
                  'Очистка демо и канонического набора. Ваши библиотеки Viewer сохранятся.',
                )}
              </small>
            </div>
            <button
              className="btn parser-clear-database"
              disabled={locked || !counts[0]}
              onClick={() => openConfirmation('clear')}
            >
              <Trash2 size={14} aria-hidden="true" />
              {tr('Clear parser database', 'Очистить базу парсера')}
            </button>
          </footer>
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
