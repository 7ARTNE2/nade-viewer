import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ExternalLink,
  FolderOpen,
  ListChecks,
  RefreshCw,
  Search,
  Square,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { isTauri } from '../lib/tauri';
import {
  clearDemoQueue,
  downloaderBusy,
  emptyDownloader,
  filterDemoEvents,
  getDownloader,
  refreshDemoCatalog,
  selectDemoDestination,
  showHltvBrowser,
  startDemoDownloads,
  stopDemoDownloads,
  type CatalogQuery,
} from '../lib/demoDownloader';
import './DemoDownloaderTool.css';

export default function DemoDownloaderTool() {
  const { tr, locale } = useI18n();
  const [snapshot, setSnapshot] = useState(emptyDownloader);
  const [tab, setTab] = useState<'events' | 'links'>('events');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('finished');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [sort, setSort] = useState('date');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [links, setLinks] = useState('');
  const [destination, setDestination] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const lastRefreshAttempt = useRef(0);
  const busy = downloaderBusy(snapshot.phase);
  const locked = busy || pending;
  const query: CatalogQuery = {
    start: start || null,
    end: end || null,
    min_prize: min ? Number(min) : null,
    max_prize: max ? Number(max) : null,
  };
  const rangeError =
    (start && end && start > end) || (min && max && Number(min) > Number(max));

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const data = await getDownloader();
        if (!active) return;
        setSnapshot(data);
        if (!initialized.current) {
          initialized.current = true;
          setDestination(data.destination);
          setStart(data.query.start ?? '');
          setEnd(data.query.end ?? '');
          setMin(data.query.min_prize?.toString() ?? '');
          setMax(data.query.max_prize?.toString() ?? '');
        }
        if (
          !downloaderBusy(data.phase) &&
          !data.error &&
          Date.now() - lastRefreshAttempt.current > 6 * 3600 * 1000 &&
          (!data.updated_at || Date.now() / 1000 - data.updated_at > 6 * 3600)
        ) {
          lastRefreshAttempt.current = Date.now();
          await refreshDemoCatalog(data.query);
        }
      } catch (cause) {
        if (active) setError(String(cause));
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const act = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await operation();
      setSnapshot(await getDownloader());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  const events = filterDemoEvents(snapshot.events, {
    search,
    kind,
    status,
    min,
    max,
    start,
    end,
  }).sort((a, b) =>
    sort === 'prize'
      ? (b.prize ?? -1) - (a.prize ?? -1)
      : sort === 'name'
        ? a.name.localeCompare(b.name)
        : (b.end_date ?? '').localeCompare(a.end_date ?? ''),
  );
  const money = (value: number | null) =>
    value === null
      ? '—'
      : new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        }).format(value);
  const toggle = (id: number) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const urls =
    tab === 'links'
      ? links.split(/\s+/).filter(Boolean)
      : snapshot.events.filter((e) => selected.has(e.id)).map((e) => e.url);
  const jobs = snapshot.jobs.filter((j) => j.id.startsWith('matches:'));
  const complete = jobs.filter((j) => j.status === 'complete').length;
  const jobLabels: Record<string, string> = {
    expanded: tr('Matches found', 'Матчи найдены'),
    queued: tr('Queued', 'В очереди'),
    complete: tr('Saved', 'Сохранено'),
    failed: tr('Error', 'Ошибка'),
    interrupted: tr('Interrupted', 'Прервано'),
    no_demo: tr('No demo yet', 'Демо пока нет'),
    checking: tr('Checking', 'Проверка'),
    downloading: tr('Downloading', 'Скачивание'),
    extracting: tr('Extracting', 'Распаковка'),
  };
  const phaseLabels: Record<string, string> = {
    starting: tr('Starting', 'Запуск'),
    idle: tr('Ready', 'Готово к работе'),
    catalog: tr('Updating tournaments', 'Обновление турниров'),
    discovering: tr('Finding matches', 'Поиск матчей'),
    checking: jobLabels.checking,
    downloading: jobLabels.downloading,
    extracting: jobLabels.extracting,
    browser_action: tr(
      'Complete the check in the HLTV window',
      'Пройдите проверку в окне HLTV',
    ),
    failed: tr('Finished with errors', 'Завершено с ошибками'),
    stopped: tr('Stopped', 'Остановлено'),
  };

  return (
    <section
      className="demo-tool"
      aria-label={tr('Demo downloads', 'Скачивание демо')}
    >
      <header className="demo-header">
        <div>
          <span className="tools-kicker">HLTV / COUNTER-STRIKE 2</span>
          <h1>{tr('Demo downloads', 'Скачивание демо')}</h1>
          <p>
            {tr(
              'Choose tournaments. Keep the demos you need.',
              'Выберите турниры и сохраните нужные демо.',
            )}
          </p>
        </div>
        <span className="demo-builtin">
          <Check size={14} />
          {tr('Built in', 'Встроено')}
        </span>
      </header>
      {!isTauri && (
        <p className="demo-notice">
          {tr(
            'Downloads are available in the Windows desktop app.',
            'Скачивание доступно в настольном приложении Windows.',
          )}
        </p>
      )}
      {(error || snapshot.error) && (
        <p className="demo-error" role="alert">
          {error || snapshot.error}
        </p>
      )}
      <div className="demo-layout">
        <div className="demo-main">
          <nav
            className="demo-tabs"
            aria-label={tr('Download source', 'Источник загрузки')}
          >
            <button
              type="button"
              aria-pressed={tab === 'events'}
              onClick={() => setTab('events')}
            >
              {tr('Tournaments', 'Турниры')}
            </button>
            <button
              type="button"
              aria-pressed={tab === 'links'}
              onClick={() => setTab('links')}
            >
              {tr('By URL', 'По ссылкам')}
            </button>
          </nav>
          {tab === 'events' ? (
            <>
              <div className="demo-search-row">
                <label className="demo-search">
                  <Search size={16} />
                  <input
                    aria-label={tr('Find a tournament', 'Найти турнир')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={tr(
                      'Tournament or location',
                      'Турнир или место проведения',
                    )}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={locked || !!rangeError || !isTauri}
                  onClick={() => void act(() => refreshDemoCatalog(query))}
                >
                  <RefreshCw
                    size={14}
                    className={snapshot.phase === 'catalog' ? 'demo-spin' : ''}
                  />
                  {tr('Update', 'Обновить')}
                </button>
              </div>
              <div className="demo-filters">
                <label>
                  {tr('Ends from', 'Окончание с')}
                  <input
                    type="date"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label>
                  {tr('Ends through', 'Окончание по')}
                  <input
                    type="date"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
                <label>
                  {tr('Prize from, $', 'Фонд от, $')}
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                    placeholder="0"
                  />
                </label>
                <label>
                  {tr('Prize through, $', 'Фонд до, $')}
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                    placeholder={tr('Any', 'Любой')}
                  />
                </label>
                <label>
                  {tr('Type', 'Тип')}
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="">{tr('All types', 'Все типы')}</option>
                    <option value="large">
                      {tr('Major + LAN $250k+', 'Major + LAN от $250 тыс.')}
                    </option>
                    {[
                      'Major',
                      'Intl. LAN',
                      'Reg. LAN',
                      'Local LAN',
                      'Online',
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr('Status', 'Статус')}
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">{tr('All', 'Все')}</option>
                    <option value="finished">
                      {tr('Finished', 'Завершённые')}
                    </option>
                    <option value="ongoing">
                      {tr('Ongoing', 'Идут сейчас')}
                    </option>
                  </select>
                </label>
              </div>
              <div className="demo-presets">
                {[1, 3, 12].map((months) => (
                  <button
                    type="button"
                    className="micro-btn"
                    key={months}
                    onClick={() => {
                      const d = new Date();
                      const to = d.toLocaleDateString('en-CA');
                      d.setMonth(d.getMonth() - months);
                      setStart(d.toLocaleDateString('en-CA'));
                      setEnd(to);
                    }}
                  >
                    {months === 1
                      ? tr('Last month', 'За месяц')
                      : months === 3
                        ? tr('3 months', '3 месяца')
                        : tr('Last year', 'За год')}
                  </button>
                ))}
                <button
                  type="button"
                  className="micro-btn"
                  onClick={() => {
                    setStart('');
                    setEnd('');
                    setMin('');
                    setMax('');
                    setKind('');
                    setSearch('');
                  }}
                >
                  {tr('Reset', 'Сбросить')}
                </button>
              </div>
              {rangeError && (
                <p className="demo-error" role="alert">
                  {tr(
                    'The lower bound must not exceed the upper bound.',
                    'Начало диапазона не должно превышать конец.',
                  )}
                </p>
              )}
              <div className="demo-list-heading">
                <span>
                  {events.length} {tr('tournaments', 'турниров')}
                </span>
                <select
                  aria-label={tr('Sort tournaments', 'Сортировка турниров')}
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="date">
                    {tr('Newest first', 'Сначала новые')}
                  </option>
                  <option value="prize">
                    {tr('Largest prize first', 'Сначала крупные')}
                  </option>
                  <option value="name">{tr('By name', 'По названию')}</option>
                </select>
              </div>
              <div className="demo-table-scroll">
                <table className="demo-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label={tr(
                            'Select visible tournaments',
                            'Выбрать видимые турниры',
                          )}
                          checked={
                            events.length > 0 &&
                            events.every((e) => selected.has(e.id))
                          }
                          disabled={locked || !events.length}
                          onChange={(e) =>
                            setSelected((old) => {
                              const next = new Set(old);
                              events.forEach((event) =>
                                e.target.checked
                                  ? next.add(event.id)
                                  : next.delete(event.id),
                              );
                              return next;
                            })
                          }
                        />
                      </th>
                      <th>{tr('Tournament', 'Турнир')}</th>
                      <th>{tr('Dates', 'Даты')}</th>
                      <th>{tr('Prize pool', 'Призовой фонд')}</th>
                      <th>{tr('Teams', 'Команд')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr
                        key={event.id}
                        className={selected.has(event.id) ? 'is-selected' : ''}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={event.name}
                            id={`demo-event-${event.id}`}
                            checked={selected.has(event.id)}
                            disabled={locked}
                            onChange={() => toggle(event.id)}
                          />
                        </td>
                        <td>
                          <label
                            htmlFor={`demo-event-${event.id}`}
                            className="demo-event-name"
                          >
                            {event.name}
                          </label>
                          <span className="demo-event-meta">
                            {event.kind ||
                              (event.status === 'ongoing'
                                ? tr('Ongoing', 'Идёт сейчас')
                                : '—')}
                            {event.location && ` · ${event.location}`}
                          </span>
                        </td>
                        <td className="demo-dates">
                          {event.start_date}
                          <span>{event.end_date}</span>
                        </td>
                        <td
                          title={
                            event.club_share === null
                              ? undefined
                              : `${tr('Players', 'Игрокам')}: ${money(event.player_share)} · ${tr('Clubs', 'Клубам')}: ${money(event.club_share)}`
                          }
                        >
                          {money(event.prize)}
                          {event.club_share !== null && (
                            <span className="demo-event-meta">
                              {tr('incl. club share', 'включая долю клубов')}
                            </span>
                          )}
                        </td>
                        <td>{event.teams || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!events.length && (
                <div className="demo-empty">
                  <ListChecks size={28} />
                  <strong>
                    {snapshot.phase === 'catalog'
                      ? tr('Loading tournaments…', 'Получаем турниры…')
                      : tr(
                          'No tournaments to show',
                          'Нет турниров для отображения',
                        )}
                  </strong>
                  <span>
                    {tr(
                      'Change filters and update the catalog.',
                      'Измените фильтры и обновите каталог.',
                    )}
                  </span>
                </div>
              )}
              <footer className="demo-catalog-footer">
                <span>
                  {snapshot.updated_at
                    ? `${tr('Updated', 'Обновлено')}: ${new Date(snapshot.updated_at * 1000).toLocaleString(locale)}`
                    : tr(
                        'Catalog has not been loaded yet',
                        'Каталог ещё не загружен',
                      )}
                </span>
                <span>
                  {tr(
                    'Refreshes every 6 hours while open',
                    'Обновляется раз в 6 часов, пока открыт',
                  )}
                </span>
              </footer>
              <p className="demo-hint">
                {tr(
                  'Dates refer to the final day. With empty dates, the latest 3 months are loaded. Apply new ranges with Update.',
                  'Даты — по дню окончания турнира. Без дат загружаются последние 3 месяца. Новый диапазон примените кнопкой «Обновить».',
                )}
                {snapshot.updated_at && !snapshot.catalog_complete
                  ? ` ${tr('The list is partial; narrow the period.', 'Список неполный; сузьте период.')}`
                  : ''}
              </p>
            </>
          ) : (
            <div className="demo-links">
              <label htmlFor="demo-urls">
                {tr('Tournament and match URLs', 'Ссылки на турниры и матчи')}
              </label>
              <textarea
                id="demo-urls"
                value={links}
                disabled={locked}
                onChange={(e) => setLinks(e.target.value)}
                placeholder="https://www.hltv.org/events/…"
                rows={10}
              />
              <p>
                {tr(
                  'One URL per line. Only missing matches will be downloaded.',
                  'Каждая ссылка с новой строки. Скачаются только недостающие матчи.',
                )}
              </p>
            </div>
          )}
          <div className="demo-start-bar">
            <span>
              {urls.length} {tr('selected', 'выбрано')}
            </span>
            <button
              type="button"
              className="btn primary"
              disabled={locked || !urls.length || !destination || !isTauri}
              onClick={() =>
                void act(() => startDemoDownloads(urls, destination))
              }
            >
              <ArrowDownToLine size={15} />
              {tr('Download selected', 'Скачать выбранные')}
            </button>
          </div>
        </div>
        <aside className="demo-queue">
          <div className="demo-queue-title">
            <h2>{tr('Download queue', 'Очередь загрузки')}</h2>
            <span>
              {complete}/{jobs.length}
            </span>
          </div>
          <label className="demo-destination">
            {tr('Save demos to', 'Папка для демо')}
            <input
              aria-label={tr('Destination folder', 'Папка назначения')}
              value={destination}
              disabled={locked}
              onChange={(e) => setDestination(e.target.value)}
              placeholder={tr('Choose a folder', 'Выберите папку')}
            />
            <button
              type="button"
              className="btn"
              disabled={locked || !isTauri}
              onClick={() =>
                void act(async () => {
                  const path = await selectDemoDestination();
                  if (path) setDestination(path);
                })
              }
            >
              <FolderOpen size={14} />
              {tr('Choose folder', 'Выбрать папку')}
            </button>
          </label>
          <div
            className={`demo-run-state ${busy ? 'is-active' : ''}`}
            role="status"
          >
            <span>{phaseLabels[snapshot.phase] ?? snapshot.phase}</span>
            {snapshot.current && <small>{snapshot.current}</small>}
            {snapshot.bytes > 0 && (
              <strong>
                {(snapshot.bytes / 1e6).toFixed(1)}{' '}
                {tr('MB received', 'МБ получено')}
              </strong>
            )}
          </div>
          {busy ? (
            <div className="demo-queue-actions">
              <button
                type="button"
                className="btn danger-action"
                onClick={() => void act(stopDemoDownloads)}
              >
                <Square size={13} />
                {tr('Stop', 'Остановить')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void act(showHltvBrowser)}
              >
                <ExternalLink size={13} />
                HLTV
              </button>
            </div>
          ) : (
            <div className="demo-queue-actions">
              <button
                type="button"
                className="btn"
                disabled={!snapshot.jobs.length || !destination || pending}
                onClick={() =>
                  void act(() => startDemoDownloads([], destination))
                }
              >
                <RefreshCw size={13} />
                {tr('Continue / retry', 'Продолжить')}
              </button>
              <button
                type="button"
                className="micro-btn"
                disabled={
                  pending || !snapshot.jobs.some((j) => j.status !== 'complete')
                }
                onClick={() => void act(clearDemoQueue)}
              >
                {tr('Clear pending', 'Убрать ожидающие')}
              </button>
            </div>
          )}
          <ol className="demo-job-list">
            {snapshot.jobs
              .slice()
              .reverse()
              .map((job) => (
                <li key={job.id}>
                  <div>
                    <strong>{job.name}</strong>
                    <span className={`demo-job-status is-${job.status}`}>
                      {jobLabels[job.status] ?? job.status}
                    </span>
                  </div>
                  {job.files.length > 0 && (
                    <small>
                      {job.files.length}{' '}
                      {tr('demo files saved', 'файлов демо сохранено')}
                    </small>
                  )}
                  {job.error && (
                    <small className="demo-error">{job.error}</small>
                  )}
                </li>
              ))}
          </ol>
          {!snapshot.jobs.length && (
            <p className="demo-queue-empty">
              {tr(
                'Selected tournaments will appear here when you start downloading.',
                'Выбранные турниры появятся здесь после запуска загрузки.',
              )}
            </p>
          )}
          <p className="demo-hint">
            {tr(
              'Archives are removed after demos are saved. Failed extractions keep the archive for retry.',
              'Архивы удаляются после сохранения демо. При ошибке распаковки архив остаётся для повтора.',
            )}
          </p>
        </aside>
      </div>
    </section>
  );
}
