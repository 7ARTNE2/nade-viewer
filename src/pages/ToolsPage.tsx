import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { CheckCircle2, Database, FileJson, FolderOpen, Gauge, Package, Play, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { importJson } from '../lib/tauri';
import { useI18n } from '../i18n';

type Props = { refreshImports?: () => Promise<void> };
type Status = { running: boolean; stage: string; output?: string; error?: string; completed: number; total: number; current?: string };
export default function ToolsPage({ refreshImports }: Props) {
  const { tr } = useI18n();
  const [installed, setInstalled] = useState(false);
  const [status, setStatus] = useState<Status>({ running: false, stage: 'idle', completed: 0, total: 0 });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dedup, setDedup] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<'raw'|'canonical'>('raw');
  const [counts, setCounts] = useState<[number, number]>([0, 0]);
  const refresh = async () => {
    const info = await invoke<{ installed: boolean }>('get_nade_parser_info');
    setInstalled(info.installed);
    setStatus(await invoke<Status>('get_nade_parser_status'));
    setCounts(await invoke<[number, number]>('get_parser_workspace_counts'));
  };
  useEffect(() => { refresh().catch(e => setError(String(e))); }, []);
  useEffect(() => {
    if (!status.running) return;
    let active = true;
    const id = window.setInterval(() => {
      invoke<Status>('get_nade_parser_status').then(s => { if (active) setStatus(s); }).catch(e => { if (active) setError(String(e)); });
    }, 500);
    return () => { active = false; window.clearInterval(id); };
  }, [status.running]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(''); setError('');
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const locked = busy || status.running;
  const stages: Record<string, string> = {
    idle: tr('Ready', 'Готово'), scanning: tr('Scanning folders...', 'Поиск демо в папках...'),
    parsing: tr('Parsing demos', 'Разбор демо'), finalizing: tr('Writing combined result...', 'Сохранение общего результата...'),
    complete: tr('Complete', 'Завершено'), failed: tr('Job failed. No new result was published.', 'Задача завершилась ошибкой. Новый результат не сохранён.'),
  };
  const progress = status.total ? Math.round((status.completed / status.total) * 100) : 0;
  return <section className="tools-view"><div className="tools-header"><div><span className="tools-kicker">TOOLS / PIPELINE</span><h1>Nade Parser</h1><p>{tr('Turn demos into a clean, reviewable lineup library.', 'Превратите демо в чистую библиотеку раскидок.')}</p></div><div className={`tools-health ${installed ? 'ok' : 'warn'}`}>{installed ? <CheckCircle2 size={16}/> : <XCircle size={16}/>}<span>{installed ? tr('Plugin ready', 'Плагин готов') : tr('Plugin required', 'Нужен плагин')}</span></div></div><div className="tools-grid">
     <div className="tools-card tools-input"><div className="tools-card-title"><FolderOpen size={18}/><div><strong>{tr('Input sources', 'Источники')}</strong><small>{tr('One demo or many folders', 'Одно демо или несколько папок')}</small></div></div>
       <div className="tools-actions"><button className="btn" disabled={locked} onClick={() => void action(async () => { const p = await invoke<string | null>('select_demo_file'); if (p) setPaths([p]); })}>{tr('Choose demo', 'Выбрать демо')}</button><button className="btn" disabled={locked} onClick={() => void action(async () => { const p = await invoke<string[]>('select_demo_folders'); setPaths(old => [...new Set([...old, ...p])]); })}>{tr('Add folders', 'Добавить папки')}</button></div>
       {paths.length > 0 ? <ul className="tools-paths" aria-label={tr('Selected paths', 'Выбранные пути')}>
         {paths.map(path => <li key={path}><span title={path}>{path}</span><button disabled={locked} aria-label={`${tr('Remove', 'Удалить')}: ${path}`} onClick={() => setPaths(old => old.filter(p => p !== path))}>×</button></li>)}
       </ul> : <div className="tools-empty"><FolderOpen size={20}/><span>{tr('No sources selected yet', 'Источники ещё не выбраны')}</span></div>}
       <label className="tools-check"><input type="checkbox" disabled={locked} checked={dedup} onChange={e => setDedup(e.target.checked)}/><span><b>{tr('Build canonical set', 'Создать канонический набор')}</b><small>{tr('Keep raw throws available for later recomputation.', 'Исходные броски сохранятся для повторной обработки.')}</small></span></label>
       <button className="btn primary tools-run" disabled={locked || !installed || !paths.length} onClick={() => void action(async () => { await invoke('run_nade_parser_batch', { paths, deduplicate: dedup }); setStatus(await invoke<Status>('get_nade_parser_status')); })}><Play size={15}/>{tr('Start parsing', 'Начать парсинг')}</button>
     </div><div className="tools-card tools-status">
       <div className="tools-card-title"><Gauge size={18}/><div><strong>{tr('Live processing', 'Текущая обработка')}</strong><small>{stages[status.stage] || status.stage}</small></div></div>
       <div className="tools-progress"><div className="tools-progress-meta"><b>{progress}%</b><span>{status.total ? `${status.completed} / ${status.total} ${tr('demos', 'демо')}` : tr('Waiting for a run', 'Ожидание запуска')}</span></div><div className="progress-shell"><div className="progress-bar" style={{ width: `${progress}%` }}/></div></div>
       <div className="tools-current" role="status"><span>{status.current ? tr('Current file', 'Текущий файл') : tr('Status', 'Статус')}</span><strong>{status.current || stages[status.stage] || status.stage}</strong></div>
       {(error || status.error) && <div className="tools-error" role="alert"><XCircle size={16}/><span>{error || status.error}</span></div>}
       <div className="tools-stats"><div><Database size={15}/><b>{counts[0].toLocaleString()}</b><span>{tr('raw throws', 'исходных бросков')}</span></div><div><Package size={15}/><b>{counts[1].toLocaleString()}</b><span>{tr('demos indexed', 'демо в базе')}</span></div></div>
     </div><div className="tools-card tools-output">
       <div className="tools-card-title"><ShieldCheck size={18}/><div><strong>{tr('Review and export', 'Проверка и экспорт')}</strong><small>{tr('Nothing is imported automatically', 'Автоматический импорт отключён')}</small></div></div>
       <label className="tools-field">{tr('Dataset', 'Набор данных')}<select value={source} onChange={e => setSource(e.target.value as 'raw'|'canonical')}><option value="raw">{tr('Raw throws', 'Исходные броски')}</option><option value="canonical">{tr('Canonical throws', 'Канонические броски')}</option></select></label>
       <div className="tools-actions"><button className="btn" disabled={locked} onClick={() => void action(async()=>{await invoke('deduplicate_parser_workspace'); await refresh();})}><RefreshCw size={14}/>{tr('Recompute', 'Пересчитать')}</button><button className="btn" disabled={locked} onClick={() => void action(async()=>{const p=await invoke<string|null>('save_parser_output',{output:status.output || 'workspace',format:'json'});if(p)setMessage(`${tr('Saved', 'Сохранено')}: ${p}`);})}><FileJson size={14}/>JSON</button><button className="btn" disabled={locked} onClick={() => void action(async()=>{const p=await invoke<string|null>('save_parser_output',{output:status.output || 'workspace',format:'msgpack'});if(p)setMessage(`${tr('Saved', 'Сохранено')}: ${p}`);})}>MPK</button></div>
       <button className="btn primary tools-import" disabled={locked || !status.output} onClick={() => void action(async () => { await importJson(status.output!); await refreshImports?.(); setMessage(tr('Imported into Viewer', 'Импортировано в Viewer')); })}>{tr('Import selected dataset into Viewer', 'Импортировать выбранный набор')}</button>
       {message && <p className="tools-message" role="status">{message}</p>}
     </div>
     </div>
     {/* legacy status content intentionally replaced by the structured workspace above */}
     {false && <div className="import-action-card">
       <div className="drop-zone" role="status" style={{ padding: 16, overflowWrap: 'anywhere' }}>
        <strong>{stages[status.stage] || status.stage}</strong>
        {status.total > 0 && <span>{tr('Completed demos', 'Завершено демо')}: {status.completed} / {status.total}</span>}
        {status.current && <span>{status.current}</span>}
      </div>
      {(error || status.error) && <p role="alert" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{tr('Error', 'Ошибка')}: {error || status.error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="file-picker-row">
        <button className="btn" disabled={locked} onClick={() => void action(async () => { const p = await invoke<string | null>('select_demo_file'); if (p) setPaths([p]); })}>{tr('Choose demo', 'Выбрать демо')}</button>
        <button className="btn" disabled={locked} onClick={() => void action(async () => { const p = await invoke<string[]>('select_demo_folders'); setPaths(old => [...new Set([...old, ...p])]); })}>{tr('Add folders', 'Добавить папки')}</button>
      </div>
      {paths.length > 0 && <ul style={{ padding: 0, listStyle: 'none', maxHeight: 240, overflow: 'auto' }} aria-label={tr('Selected paths', 'Выбранные пути')}>
        {paths.map(path => <li key={path} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBlock: 8 }}>
          <span style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{path}</span>
          <button className="btn" disabled={locked} aria-label={`${tr('Remove', 'Удалить')}: ${path}`} onClick={() => setPaths(old => old.filter(p => p !== path))}>{tr('Remove', 'Удалить')}</button>
        </li>)}
      </ul>}
       <p>{tr(`Workspace: ${counts[0]} raw throws, ${counts[1]} demos`, `Рабочая область: ${counts[0]} бросков, ${counts[1]} демо`)}</p>
       <label>{tr('Export source', 'Источник')}: <select value={source} onChange={e => setSource(e.target.value as 'raw'|'canonical')}><option value="raw">{tr('Raw','Исходные')}</option><option value="canonical">{tr('Canonical','Канонические')}</option></select></label>
       <label className="toggle"><input type="checkbox" disabled={locked} checked={dedup} onChange={e => setDedup(e.target.checked)} />{tr('Deduplicate output', 'Удалить дубликаты')}</label>
       <button className="btn" disabled={locked} onClick={() => void action(async()=>{await invoke('deduplicate_parser_workspace'); await refresh();})}>{tr('Recompute canonical', 'Пересчитать канонические')}</button>
      <div className="file-picker-row">
        <button className="btn primary" disabled={locked || !installed || !paths.length} onClick={() => void action(async () => { await invoke('run_nade_parser_batch', { paths, deduplicate: dedup }); setStatus(await invoke<Status>('get_nade_parser_status')); })}>{tr('Parse selected paths', 'Разобрать выбранное')}</button>
        {!installed && <button className="btn" disabled={locked} onClick={() => void action(async () => { if (window.confirm(tr('Only install a plugin you trust. Continue?', 'Устанавливайте только доверенный плагин. Продолжить?'))) { await invoke('install_nade_parser'); await refresh(); } })}>{tr('Install plugin', 'Установить плагин')}</button>}
      </div>
      {status.output && !status.running && <>
        <p>{status.stage === 'failed' ? tr('Previous successful result is still available.', 'Предыдущий успешный результат по-прежнему доступен.') : tr('Result ready. Choose an action.', 'Результат готов. Выберите действие.')}</p>
        <div className="file-picker-row">
          {['json', 'msgpack'].map(format => <button className="btn" key={format} disabled={busy} onClick={() => void action(async () => { const p = await invoke<string | null>('save_parser_output', { output: status.output, format }); if (p) setMessage(`${tr('Saved', 'Сохранено')}: ${p}`); })}>{tr('Save', 'Сохранить')} {format === 'json' ? 'JSON' : 'MessagePack'}</button>)}
          <button className="btn" disabled={busy} onClick={() => void action(async () => { await importJson(status.output!); await refreshImports?.(); setMessage(tr('Imported into Viewer', 'Импортировано в Viewer')); })}>{tr('Import into Viewer', 'Импортировать в Viewer')}</button>
        </div>
      </>}
     </div>}
   </section>;
}
