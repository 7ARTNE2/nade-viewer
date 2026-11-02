import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Pencil, Search, StickyNote, X } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  replayNoteTime,
  retryReplayNotes,
  useAllReplayNotes,
} from '../lib/replayNotes';
import type { ReplayEntry } from '../types/replay';
import FilterSelect from './FilterSelect';

export default function ReplayNotesPanel({
  entries,
  selectedId,
  onSelect,
}: {
  entries: ReplayEntry[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const { tr } = useI18n();
  const { items, loading, loadError, saveErrors } = useAllReplayNotes();
  const [query, setQuery] = useState('');
  const [map, setMap] = useState('');
  const [round, setRound] = useState('');
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState('');
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const all = items.filter((item) => entryById.has(item.replay_id));
  const scoped = all.filter(
    (item) =>
      (selectedId === null || item.replay_id === selectedId) &&
      (!map || entryById.get(item.replay_id)?.metadata.map === map),
  );
  const rounds = [...new Set(scoped.map((item) => item.note.round))].sort(
    (a, b) => a - b,
  );
  const search = query.trim().toLocaleLowerCase();
  const visible = scoped
    .filter(({ note, replay_id }) => {
      const entry = entryById.get(replay_id)!;
      return (
        (!round || String(note.round) === round) &&
        (!kind ||
          (kind === 'text'
            ? !!note.text.trim()
            : kind === 'drawing'
              ? !!note.strokes.length
              : !!note.text.trim() && !!note.strokes.length)) &&
        `${note.text} ${entry.metadata.demo_filename} ${entry.metadata.map} ${entry.metadata.team_t} ${entry.metadata.team_ct} R${note.round} ${tr('Round', 'Раунд')} ${note.round}`
          .toLocaleLowerCase()
          .includes(search)
      );
    })
    .sort((a, b) =>
      order === 'moment'
        ? b.replay_id - a.replay_id ||
          a.note.round - b.note.round ||
          a.note.tick - b.note.tick ||
          a.note.id.localeCompare(b.note.id)
        : b.updated_at - a.updated_at ||
          b.replay_id - a.replay_id ||
          a.note.round - b.note.round ||
          a.note.tick - b.note.tick ||
          a.note.id.localeCompare(b.note.id),
    );
  const filtered =
    selectedId !== null || !!map || !!round || !!kind || !!search;
  const reset = () => {
    onSelect(null);
    setMap('');
    setRound('');
    setKind('');
    setQuery('');
    setOrder('');
  };
  const filterProps = {
    selectionMode: 'single' as const,
    icon: null,
    selectedCountLabel: (count: number) => String(count),
    searchPlaceholder: tr('Search…', 'Поиск…'),
    emptyLabel: tr('No options', 'Нет вариантов'),
    className: 'replay-note-filter',
  };
  return (
    <aside
      className="replay-history-notes"
      aria-label={tr('All replay notes', 'Все заметки реплеев')}
    >
      <header>
        <h2>
          <StickyNote size={17} />
          {tr('Notes', 'Заметки')}
        </h2>
        <span className="replay-count" aria-live="polite">
          {filtered ? `${visible.length} / ${all.length}` : all.length}
        </span>
      </header>
      <p className="replay-history-notes-source">
        {tr(
          'Text and drawings from all matches',
          'Текст и рисунки из всех матчей',
        )}
      </p>
      <label className="replay-history-notes-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={tr('Search notes', 'Поиск заметок')}
          placeholder={tr('Text, map or match…', 'Текст, карта или матч…')}
        />
      </label>
      <div className="replay-notes-filters">
        <FilterSelect
          {...filterProps}
          label={tr('Replay', 'Реплей')}
          value={selectedId === null ? [] : [String(selectedId)]}
          options={[
            { value: '', label: tr('All matches', 'Все матчи') },
            ...entries.map((entry) => ({
              value: String(entry.id),
              label: entry.metadata.demo_filename,
              meta: entry.metadata.map,
            })),
          ]}
          onChange={(value) => {
            onSelect(value[0] ? Number(value[0]) : null);
            setRound('');
          }}
        />
        <FilterSelect
          {...filterProps}
          label={tr('Map', 'Карта')}
          value={map ? [map] : []}
          options={[
            { value: '', label: tr('All maps', 'Все карты') },
            ...[...new Set(entries.map((entry) => entry.metadata.map))]
              .sort()
              .map((name) => ({ value: name, label: name })),
          ]}
          onChange={(value) => {
            setMap(value[0] ?? '');
            setRound('');
          }}
        />
        <FilterSelect
          {...filterProps}
          label={tr('Round', 'Раунд')}
          value={round ? [round] : []}
          options={[
            { value: '', label: tr('All rounds', 'Все раунды') },
            ...rounds.map((number) => ({
              value: String(number),
              label: `${tr('Round', 'Раунд')} ${number}`,
            })),
          ]}
          onChange={(value) => setRound(value[0] ?? '')}
        />
        <FilterSelect
          {...filterProps}
          label={tr('Note type', 'Тип заметки')}
          value={kind ? [kind] : []}
          options={[
            { value: '', label: tr('All types', 'Все типы') },
            { value: 'text', label: tr('With text', 'С текстом') },
            { value: 'drawing', label: tr('With drawings', 'С рисунками') },
            {
              value: 'both',
              label: tr('Text and drawings', 'Текст и рисунки'),
            },
          ]}
          onChange={(value) => setKind(value[0] ?? '')}
        />
        <FilterSelect
          {...filterProps}
          label={tr('Sort notes', 'Сортировка заметок')}
          value={order ? [order] : []}
          options={[
            { value: '', label: tr('Recently edited', 'Недавно изменённые') },
            {
              value: 'moment',
              label: tr('Match, round and time', 'Матч, раунд и время'),
            },
          ]}
          onChange={(value) => setOrder(value[0] ?? '')}
        />
        {filtered && (
          <button className="replay-notes-reset" onClick={reset}>
            <X size={13} />
            {tr('Reset filters', 'Сбросить фильтры')}
          </button>
        )}
      </div>
      {(loadError || Object.keys(saveErrors).length > 0) && (
        <p className="replay-notes-error" role="alert">
          {tr(
            'Unable to load or save notes.',
            'Не удалось загрузить или сохранить заметки.',
          )}{' '}
          <button onClick={() => retryReplayNotes()}>
            {tr('Retry', 'Повторить')}
          </button>
        </p>
      )}
      {loading ? (
        <p className="replay-history-notes-empty" role="status">
          {tr('Loading notes…', 'Загрузка заметок…')}
        </p>
      ) : !all.length && !loadError ? (
        <div className="replay-history-notes-empty">
          <StickyNote size={25} />
          <strong>{tr('No notes yet', 'Пока нет заметок')}</strong>
          <p>
            {tr(
              'Add text or drawings in the replay. They will appear here with their round and time.',
              'Добавьте текст или рисунки в реплее. Здесь появятся записи с номером раунда и временем.',
            )}
          </p>
        </div>
      ) : (
        <div className="replay-history-note-groups">
          {!visible.length && !loadError && (
            <p className="replay-history-notes-empty">
              {tr('No matching notes', 'Заметки не найдены')}
            </p>
          )}
          {visible.map(({ note, replay_id, round_summary, updated_at }) => {
            const entry = entryById.get(replay_id)!;
            return (
              <article
                className="replay-history-note-round"
                key={`${replay_id}:${note.id}`}
              >
                <Link
                  className="replay-history-note"
                  to={`/replays/${replay_id}?note=${encodeURIComponent(note.id)}`}
                  aria-label={`${tr('Open note', 'Открыть заметку')}: ${tr('Round', 'Раунд')} ${note.round}, ${note.text.trim() || tr('Drawing', 'Рисунок')}`}
                >
                  <span
                    className="replay-history-note-source"
                    data-tip={entry.metadata.demo_filename}
                  >
                    {entry.metadata.map} · {entry.metadata.demo_filename}
                  </span>
                  <div className="replay-history-note-meta">
                    <h3>
                      {tr('Round', 'Раунд')} {note.round}
                    </h3>
                    <time>
                      {replayNoteTime(
                        note,
                        entry.metadata.tickrate,
                        round_summary ?? undefined,
                      )}
                    </time>
                    {note.lower && (
                      <small>{tr('Lower radar', 'Нижний этаж')}</small>
                    )}
                    <ArrowUpRight size={14} />
                  </div>
                  <p>{note.text.trim() || tr('Drawing', 'Рисунок')}</p>
                  <div className="replay-history-note-footer">
                    {note.strokes.length > 0 && (
                      <small className="replay-history-note-drawings">
                        <Pencil size={12} />
                        {tr('Drawings', 'Рисунки')}: {note.strokes.length}
                      </small>
                    )}
                    <time
                      dateTime={new Date(updated_at).toISOString()}
                      data-tip={new Date(updated_at).toLocaleString()}
                    >
                      {new Date(updated_at).toLocaleDateString()}
                    </time>
                  </div>
                </Link>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
}
