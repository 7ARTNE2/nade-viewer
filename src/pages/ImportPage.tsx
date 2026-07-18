import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  CheckCircle2,
  Database,
  FileJson,
  FolderOpen,
  History,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import {
  getImportStatus,
  importJson,
  isTauri,
  selectImportFile,
} from '../lib/tauri';
import { compactDate, formatNumber } from '../lib/format';
import type { ImportStatus, ImportSummary } from '../types/domain';
import { useI18n } from '../i18n';

type Props = {
  onImported: () => Promise<void>;
  lastImport: ImportSummary | null;
};

export default function ImportPage({ onImported, lastImport }: Props) {
  const { locale, tr } = useI18n();
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const [status, setStatus] = useState<ImportStatus>({
    running: false,
    stage: 'idle',
    current: 0,
    total: 0,
    message: 'Ready',
  });
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const runImportRef = useRef<(nextPath?: string) => Promise<void>>(
    async () => undefined,
  );
  const progress = useMemo(
    () =>
      status.total > 0
        ? Math.min(100, Math.round((status.current / status.total) * 100))
        : busy
          ? 8
          : 0,
    [busy, status],
  );

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      getImportStatus()
        .then(setStatus)
        .catch((error) => {
          console.error('Unable to read import progress', error);
          setStatus((current) => ({
            ...current,
            message: tr(
              'Unable to read import progress',
              'Не удалось получить ход импорта',
            ),
          }));
        });
    }, 350);
    return () => window.clearInterval(timer);
  }, [busy, locale]);

  const choose = async () => {
    try {
      const selected = await selectImportFile();
      if (selected) setPath(selected);
    } catch (error) {
      console.error(error);
      setMessage(
        tr('Unable to open the file picker', 'Не удалось открыть выбор файла'),
      );
    }
  };

  const runImport = async (nextPath = path) => {
    if (!nextPath.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const report = await importJson(nextPath.trim());
      setStatus(await getImportStatus());
      await onImported();
      if (report.kind === 'core_nades') {
        setMessage(
          tr(
            `Imported ${formatNumber(report.grenade_count)} Core Nades snapshot`,
            `Импортирован снимок Core Nades: ${formatNumber(report.grenade_count)} гранат`,
          ),
        );
      }
      navigate('/maps', { replace: true });
    } catch (error) {
      const importError =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code: string; message?: string })
          : null;
      const translated: Record<string, string> = {
        import_already_running: tr(
          'An import is already running',
          'Импорт уже выполняется',
        ),
        import_state_unavailable: tr(
          'Import state is unavailable',
          'Состояние импорта недоступно',
        ),
        file_unavailable: tr(
          'The JSON file cannot be opened',
          'Не удалось открыть JSON-файл',
        ),
        file_too_large: tr(
          'The JSON file exceeds the 100 MiB limit',
          'JSON-файл превышает лимит 100 МиБ',
        ),
        invalid_json: tr(
          'The file is not valid JSON',
          'Файл содержит некорректный JSON',
        ),
        invalid_top_level: tr(
          'The top-level JSON value must be an object',
          'Верхний уровень JSON должен быть объектом',
        ),
        ambiguous_format: tr(
          'The file mixes two import formats',
          'В файле смешаны два формата импорта',
        ),
        unsupported_format: tr(
          'Expected grenade_index or Core Nades JSON',
          'Ожидается JSON grenade_index или Core Nades',
        ),
        missing_version: tr(
          'Core Nades JSON requires version 1',
          'Для Core Nades JSON требуется версия 1',
        ),
        invalid_version: tr(
          'The top-level version must be an integer',
          'Версия верхнего уровня должна быть целым числом',
        ),
        unsupported_version: tr(
          'This JSON version is not supported',
          'Эта версия JSON не поддерживается',
        ),
        invalid_canonical_format: tr(
          'Invalid grenade_index structure',
          'Некорректная структура grenade_index',
        ),
        invalid_core_format: tr(
          'Invalid Core Nades structure',
          'Некорректная структура Core Nades',
        ),
      };
      if (importError) {
        const summary =
          translated[importError.code] ?? tr('Import failed', 'Ошибка импорта');
        setMessage(summary);
      } else {
        setMessage(tr('Import failed', 'Ошибка импорта'));
      }
    } finally {
      setBusy(false);
    }
  };
  runImportRef.current = runImport;

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
            candidate.toLowerCase().endsWith('.json'),
          );
          if (droppedPath) {
            setPath(droppedPath);
            runImportRef.current(droppedPath).catch((error) => {
              console.error('Unable to import dropped file', error);
              setMessage(tr('Import failed', 'Ошибка импорта'));
            });
          } else {
            setMessage(tr('Drop a JSON file', 'Перетащите JSON-файл'));
          }
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        console.error('Unable to listen for file drops', error);
        setMessage(
          tr('File drop is unavailable', 'Перетаскивание файлов недоступно'),
        );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [locale]);

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
              'Load a grenade index or a curated Core Nades collection. Everything stays on this device.',
              'Загрузите индекс гранат или коллекцию Core Nades. Все данные останутся на этом устройстве.',
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
          <div
            className={`drop-zone ${busy ? 'working' : ''} ${dragging ? 'dragging' : ''}`}
          >
            <Database size={24} />
            <strong>
              {busy
                ? status.message
                : dragging
                  ? tr('Release to import JSON', 'Отпустите для импорта JSON')
                  : (message ??
                    tr('Drop JSON file here', 'Перетащите JSON-файл сюда'))}
            </strong>
            <span>
              {busy
                ? tr(`${progress}% complete`, `Выполнено ${progress}%`)
                : tr(
                    'grenade_index.json or Core Nades JSON',
                    'grenade_index.json или JSON Core Nades',
                  )}
            </span>
          </div>

          {busy ? (
            <div className="progress-shell">
              <div
                className="progress-bar"
                style={{ width: `${Math.max(progress, 6)}%` }}
              />
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
              placeholder={tr('Path to JSON file', 'Путь к JSON-файлу')}
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
        </div>
      </section>
    </div>
  );
}
