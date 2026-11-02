import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, Play, StickyNote, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { useReplayNotes } from '../lib/replayNotes';
import ReplayNotesPanel from './ReplayNotesPanel';
import type { ReplayEntry } from '../types/replay';
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
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
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
                  onSelect={() =>
                    setSelectedId(selectedId === entry.id ? null : entry.id)
                  }
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
      <ReplayNotesPanel
        entries={entries}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
      />
    </div>
  );
}
