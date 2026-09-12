import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Database,
  FileJson,
  FolderOpen,
  Gauge,
  Package,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { importJson } from '../lib/tauri';
import { useI18n } from '../i18n';

type Props = { refreshImports?: () => Promise<void> };
type Status = {
  running: boolean;
  stage: string;
  output?: string;
  error?: string;
  completed: number;
  total: number;
  current?: string;
};
export default function ToolsPage({ refreshImports }: Props) {
  const { tr } = useI18n();
  const [installed, setInstalled] = useState(false);
  const [status, setStatus] = useState<Status>({
    running: false,
    stage: 'idle',
    completed: 0,
    total: 0,
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dedup, setDedup] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<'raw' | 'canonical'>('raw');
  const [counts, setCounts] = useState<[number, number]>([0, 0]);
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
    if (!status.running) return;
    let active = true;
    const id = window.setInterval(() => {
      invoke<Status>('get_nade_parser_status')
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    }, 500);
    return () => {
      active = false;
      window.clearInterval(id);
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
  const locked = busy || status.running;
  const stages: Record<string, string> = {
    idle: tr('Ready', 'Готово'),
    scanning: tr('Scanning folders...', 'Поиск демо в папках...'),
    parsing: tr('Parsing demos', 'Разбор демо'),
    finalizing: tr(
      'Writing combined result...',
      'Сохранение общего результата...',
    ),
    complete: tr('Complete', 'Завершено'),
    failed: tr(
      'Job failed. No new result was published.',
      'Задача завершилась ошибкой. Новый результат не сохранён.',
    ),
  };
  const progress = status.total
    ? Math.round((status.completed / status.total) * 100)
    : 0;
  return (
    <section className="tools-view">
      <div className="tools-header">
        <div>
          <span className="tools-kicker">TOOLS / PIPELINE</span>
          <h1>Nade Parser</h1>
          <p>
            {tr(
              'Turn demos into a clean, reviewable lineup library.',
              'Превратите демо в чистую библиотеку раскидок.',
            )}
          </p>
        </div>
        <div className={`tools-health ${installed ? 'ok' : 'warn'}`}>
          {installed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>
            {installed
              ? tr('Plugin ready', 'Плагин готов')
              : tr('Plugin required', 'Нужен плагин')}
          </span>
        </div>
      </div>
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
          <label className="tools-check">
            <input
              type="checkbox"
              disabled={locked}
              checked={dedup}
              onChange={(e) => setDedup(e.target.checked)}
            />
            <span>
              <b>{tr('Build canonical set', 'Создать канонический набор')}</b>
              <small>
                {tr(
                  'Keep raw throws available for later recomputation.',
                  'Исходные броски сохранятся для повторной обработки.',
                )}
              </small>
            </span>
          </label>
          <button
            className="btn primary tools-run"
            disabled={locked || !installed || !paths.length}
            onClick={() =>
              void action(async () => {
                await invoke('run_nade_parser_batch', {
                  paths,
                  deduplicate: dedup,
                });
                setStatus(await invoke<Status>('get_nade_parser_status'));
              })
            }
          >
            <Play size={15} />
            {tr('Start parsing', 'Начать парсинг')}
          </button>
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
                  : tr('Waiting for a run', 'Ожидание запуска')}
              </span>
            </div>
            <div className="progress-shell">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
          </div>
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
          {(error || status.error) && (
            <div className="tools-error" role="alert">
              <XCircle size={16} />
              <span>{error || status.error}</span>
            </div>
          )}
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
          <button
            className="btn danger-action"
            disabled={locked || !counts[0]}
            onClick={() =>
              void action(async () => {
                const confirmed = window.confirm(
                  tr(
                    `Clear ${counts[0].toLocaleString()} raw throws and ${counts[1].toLocaleString()} indexed demos? This also removes the deduplicated set. Imported Viewer libraries are not affected.`,
                    `Очистить ${counts[0].toLocaleString()} исходных бросков и ${counts[1].toLocaleString()} демо из базы? Канонический набор также будет удалён. Импортированные библиотеки Viewer не затрагиваются.`,
                  ),
                );
                if (!confirmed) return;
                await invoke('clear_parser_workspace');
                setSource('raw');
                await refresh();
                setMessage(
                  tr(
                    'Parser database cleared.',
                    'База данных парсера очищена.',
                  ),
                );
              })
            }
          >
            <Trash2 size={14} />
            {tr('Clear parser database', 'Очистить базу парсера')}
          </button>
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
                <span>{tr('All throws', 'Все броски')}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="parser-source"
                  value="canonical"
                  checked={source === 'canonical'}
                  onChange={() => setSource('canonical')}
                />
                <span>{tr('Deduplicated', 'Без повторов')}</span>
              </label>
            </div>
          </fieldset>
          <div className="tools-actions">
            <button
              className="btn"
              disabled={locked}
              onClick={() =>
                void action(async () => {
                  await invoke('deduplicate_parser_workspace');
                  await refresh();
                })
              }
            >
              <RefreshCw size={14} />
              {tr('Recompute', 'Пересчитать')}
            </button>
            <button
              className="btn"
              disabled={locked}
              onClick={() =>
                void action(async () => {
                  const p = await invoke<string | null>('save_parser_output', {
                    source,
                    format: 'json',
                  });
                  if (p) setMessage(`${tr('Saved', 'Сохранено')}: ${p}`);
                })
              }
            >
              <FileJson size={14} />
              JSON
            </button>
            <button
              className="btn"
              disabled={locked}
              onClick={() =>
                void action(async () => {
                  const p = await invoke<string | null>('save_parser_output', {
                    source,
                    format: 'msgpack',
                  });
                  if (p) setMessage(`${tr('Saved', 'Сохранено')}: ${p}`);
                })
              }
            >
              MPK
            </button>
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
            {tr(
              'Import selected dataset into Viewer',
              'Импортировать выбранный набор',
            )}
          </button>
          {message && (
            <p className="tools-message" role="status">
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
