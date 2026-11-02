import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  FolderOpen,
  Pencil,
  Play,
  Search,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { getReplay } from '../lib/replay';
import { replayNoteTime, useReplayNotes } from '../lib/replayNotes';
import type { ReplayDetail, ReplayEntry } from '../types/replay';
import './ReplayHistory.css';

function NotesButton({
  entry,
  selected,
  onSelect,
}: {
  entry: ReplayEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { tr } = useI18n();
  const notes = useReplayNotes(entry);
  return (
    <button
      className="replay-history-notes-button"
      aria-pressed={selected}
      aria-label={`${tr('Notes for', 'Заметки матча')} ${entry.metadata.demo_filename}: ${notes.length}`}
      data-tip={tr('View notes', 'Посмотреть заметки')}
      onClick={onSelect}
    >
      <StickyNote size={15} />
      <span>{notes.length}</span>
    </button>
  );
}

function NotesPanel({ entry }: { entry: ReplayEntry | null }) {
  const { tr } = useI18n();
  const notes = useReplayNotes(entry);
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(false);
    setQuery('');
    if (entry && notes.length)
      void getReplay(entry.id).then(
        (value) => {
          if (alive) setDetail(value);
        },
        () => {
          if (alive) setError(true);
        },
      );
    return () => {
      alive = false;
    };
  }, [entry?.id, entry?.metadata.parsed_at, notes.length]);
  const visible = notes.filter((note) =>
    `${note.text} R${note.round} ${tr('Round', 'Раунд')} ${note.round}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const rounds = [...new Set(visible.map((note) => note.round))].sort(
    (a, b) => a - b,
  );
  return (
    <aside
      className="replay-history-notes"
      aria-label={tr('Match notes', 'Заметки матча')}
    >
      <header>
        <h2>
          <StickyNote size={17} />
          {tr('Notes', 'Заметки')}
        </h2>
        <span className="replay-count">{notes.length}</span>
      </header>
      {entry && (
        <p
          className="replay-history-notes-source"
          data-tip={entry.metadata.demo_filename}
        >
          {entry.metadata.map} · {entry.metadata.demo_filename}
        </p>
      )}
      {!entry || !notes.length ? (
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
        <>
          <label className="replay-history-notes-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={tr('Search notes', 'Поиск заметок')}
              placeholder={tr('Text or round…', 'Текст или раунд…')}
            />
          </label>
          {error && (
            <p role="status">
              {tr(
                'Round timing is unavailable. Notes can still be opened.',
                'Не удалось загрузить время раундов. Заметки по-прежнему можно открыть.',
              )}
            </p>
          )}
          <div className="replay-history-note-groups">
            {!visible.length && (
              <p className="replay-history-notes-empty">
                {tr('No matching notes', 'Заметки не найдены')}
              </p>
            )}
            {rounds.map((number) => (
              <section key={number} className="replay-history-note-round">
                <h3>
                  {tr('Round', 'Раунд')} {number}
                  <small aria-hidden="true">
                    {visible.filter((note) => note.round === number).length}
                  </small>
                </h3>
                {visible
                  .filter((note) => note.round === number)
                  .sort((a, b) => a.tick - b.tick)
                  .map((note) => (
                    <Link
                      className="replay-history-note"
                      key={note.id}
                      to={`/replays/${entry.id}?note=${encodeURIComponent(note.id)}`}
                      aria-label={`${tr('Open note', 'Открыть заметку')}: ${tr('Round', 'Раунд')} ${note.round}, ${note.text.trim() || tr('Drawing', 'Рисунок')}`}
                    >
                      <div className="replay-history-note-meta">
                        <time>
                          {replayNoteTime(
                            note,
                            entry.metadata.tickrate,
                            detail?.rounds.find(
                              (round) => round.number === number,
                            ),
                          )}
                        </time>
                        {note.lower && (
                          <small>{tr('Lower radar', 'Нижний этаж')}</small>
                        )}
                        <ArrowUpRight size={14} />
                      </div>
                      <p>{note.text.trim() || tr('Drawing', 'Рисунок')}</p>
                      {note.strokes.length > 0 && (
                        <small className="replay-history-note-drawings">
                          <Pencil size={12} />
                          {tr('Drawings', 'Рисунки')}: {note.strokes.length}
                        </small>
                      )}
                    </Link>
                  ))}
              </section>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

export default function ReplayHistory({
  entries,
  capability,
  onDelete,
}: {
  entries: ReplayEntry[];
  capability: boolean;
  onDelete: (entry: ReplayEntry) => void;
}) {
  const { tr, locale } = useI18n();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected =
    entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;
  return (
    <div className="replay-history replay-history-with-notes">
      <section className="replay-history-matches">
        <div className="replay-section-title">
          <h2>{tr('Matches', 'Матчи')}</h2>
          <span className="replay-count">{entries.length}</span>
        </div>
        {!entries.length ? (
          <div className="replay-empty">
            <FolderOpen size={30} />
            <h2>{tr('No saved matches', 'Нет сохранённых матчей')}</h2>
            <span>
              {capability
                ? tr('Select a .dem file', 'Выберите файл .dem')
                : tr(
                    'Nade Parser with replay support is required',
                    'Нужен Nade Parser с поддержкой replay',
                  )}
            </span>
          </div>
        ) : (
          <div className="replay-match-list">
            {entries.map((entry) => (
              <article
                className={`replay-match-row ${selected?.id === entry.id ? 'has-selected-notes' : ''}`}
                key={entry.id}
              >
                <Link to={`/replays/${entry.id}`} className="replay-match-open">
                  <span className="replay-map-code">
                    {entry.metadata.map.replace('de_', '')}
                  </span>
                  <div>
                    <strong>
                      {entry.metadata.team_t || 'T'} <span>vs</span>{' '}
                      {entry.metadata.team_ct || 'CT'}
                    </strong>
                    <div className="replay-match-result">
                      <b>
                        {entry.score_t}:{entry.score_ct}
                      </b>
                      {entry.winner_side && (
                        <span>
                          {tr('Winner', 'Победитель')}:{' '}
                          {entry.winner_side === 'T'
                            ? entry.metadata.team_t || 'T'
                            : entry.metadata.team_ct || 'CT'}
                        </span>
                      )}
                    </div>
                    <small data-tip={entry.metadata.demo_filename}>
                      {entry.metadata.demo_filename}
                    </small>
                  </div>
                  <div className="replay-match-meta">
                    <span>
                      {entry.metadata.round_count} {tr('rounds', 'раундов')}
                      {entry.metadata.incomplete
                        ? ' · ' + tr('Incomplete', 'Неполный')
                        : ''}
                    </span>
                    <small>
                      {new Date(entry.metadata.parsed_at).toLocaleDateString(
                        locale,
                      )}{' '}
                      · {(entry.size / 1048576).toFixed(1)} MB
                    </small>
                  </div>
                  <Play size={17} />
                </Link>
                <NotesButton
                  entry={entry}
                  selected={selected?.id === entry.id}
                  onSelect={() => setSelectedId(entry.id)}
                />
                <button
                  className="icon-btn"
                  aria-label={tr('Delete match', 'Удалить матч')}
                  data-tip={tr('Delete match', 'Удалить матч')}
                  onClick={() => onDelete(entry)}
                >
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      <NotesPanel entry={selected} />
    </div>
  );
}
