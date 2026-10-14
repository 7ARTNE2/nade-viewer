import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  CheckCheck,
  Folder,
  FolderPlus,
  MapPin,
  Plus,
  RotateCw,
  Search,
  Star,
  X,
} from 'lucide-react';
import type { GrenadePreview } from '../types/domain';
import { useFavorites } from '../lib/favorites';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';
import { grenadeLabel } from '../lib/format';

function CollectionPicker({
  id,
  grenade,
  onClose,
}: {
  id: number;
  grenade: GrenadePreview;
  onClose: () => void;
}) {
  const { state, maps, busy, setCollections, createCollection } =
    useFavorites();
  const { tr, count } = useI18n();
  const map = grenade.map;
  const [selected, setSelected] = useState(state.favorites[id] ?? []);
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [operation, setOperation] = useState<'create' | 'save' | null>(null);
  const [formError, setFormError] = useState('');
  const collections = state.collections.filter((c) => c.map === map);
  const visibleCollections = collections.filter((c) =>
    c.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const selectedIds = collections
    .filter((c) => selected.includes(c.id))
    .map((c) => c.id);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);
  const ref = useModalAccessibility<HTMLDivElement>(
    true,
    close,
    initialFocusRef,
  );
  return createPortal(
    <div className="modal-scrim collection-picker-scrim" onMouseDown={close}>
      <div
        className="favorites-dialog collection-picker"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-picker-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="collection-picker-header">
          <span className="collection-picker-mark" aria-hidden="true">
            <FolderPlus size={21} />
          </span>
          <h2 id="collection-picker-title">
            {tr('Add to collections', 'Добавить в подборки')}
          </h2>
          <button
            className="icon-btn"
            disabled={busy}
            onClick={onClose}
            aria-label={tr('Close', 'Закрыть')}
            title={tr('Close', 'Закрыть')}
          >
            <X size={16} />
          </button>
        </header>
        <div className="collection-picker-context">
          <MapPin size={14} aria-hidden="true" />
          <strong>
            {maps.find((m) => m.name === map)?.label ?? map.replace(/^de_/, '')}
          </strong>
          <span>{grenadeLabel(grenade.grenade_type)}</span>
          <span>{grenade.side}</span>
        </div>
        <div className="collection-picker-body">
          {collections.length > 0 && (
            <div className="collection-picker-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={initialFocusRef}
                type="search"
                aria-label={tr('Search collections', 'Поиск подборок')}
                placeholder={tr('Search collections', 'Поиск подборок')}
                value={search}
                disabled={busy}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy}
                  aria-label={tr('Clear search', 'Очистить поиск')}
                  title={tr('Clear search', 'Очистить поиск')}
                  onClick={() => {
                    setSearch('');
                    initialFocusRef.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div
            className="collection-picker-list"
            role="group"
            aria-label={tr('Collections', 'Подборки')}
          >
            {visibleCollections.map((c) => (
              <label
                className={`collection-picker-row ${selected.includes(c.id) ? 'is-selected' : ''}`}
                key={c.id}
              >
                <input
                  type="checkbox"
                  aria-label={c.name}
                  disabled={busy}
                  checked={selected.includes(c.id)}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, c.id]
                        : ids.filter((id) => id !== c.id),
                    )
                  }
                />
                <Folder
                  className="collection-picker-folder"
                  size={19}
                  aria-hidden="true"
                />
                <span className="collection-picker-row-copy">
                  <strong>{c.name}</strong>
                  <small>
                    {count(
                      c.grenade_count,
                      'lineup',
                      'lineups',
                      'раскидка',
                      'раскидки',
                      'раскидок',
                    )}
                  </small>
                </span>
                <span className="collection-picker-check" aria-hidden="true">
                  <Check size={14} />
                </span>
              </label>
            ))}
            {!collections.length && (
              <div className="collection-picker-empty">
                <FolderPlus size={28} aria-hidden="true" />
                <strong>{tr('No collections yet', 'Пока нет подборок')}</strong>
              </div>
            )}
            {collections.length > 0 && !visibleCollections.length && (
              <div className="collection-picker-empty">
                <Search size={25} aria-hidden="true" />
                <strong>
                  {tr('No collections found', 'Подборки не найдены')}
                </strong>
              </div>
            )}
          </div>
          <form
            className="collection-picker-create"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || !name.trim()) return;
              setFormError('');
              setOperation('create');
              const created = await createCollection(name, map);
              setOperation(null);
              if (created !== undefined) {
                setName('');
                setSearch('');
                setSelected((ids) => [...ids, created]);
              } else {
                setFormError(
                  tr(
                    'Could not create collection. Try again.',
                    'Не удалось создать подборку. Повторите попытку.',
                  ),
                );
              }
            }}
          >
            <label htmlFor="collection-picker-name">
              {tr('New collection', 'Новая подборка')}
            </label>
            <div className="collection-picker-create-field">
              <input
                id="collection-picker-name"
                ref={collections.length ? undefined : initialFocusRef}
                aria-label={tr(
                  'New collection name',
                  'Название новой подборки',
                )}
                placeholder={tr('Collection name', 'Название подборки')}
                value={name}
                maxLength={100}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  setFormError('');
                }}
              />
              <button
                className="btn"
                type="submit"
                disabled={busy || !name.trim()}
              >
                <Plus size={15} aria-hidden="true" />
                {operation === 'create'
                  ? tr('Creating...', 'Создание...')
                  : tr('Create', 'Создать')}
              </button>
            </div>
          </form>
          {formError && (
            <p className="collection-picker-error" role="alert">
              {formError}
            </p>
          )}
        </div>
        <footer className="collection-picker-footer">
          <span className="collection-picker-summary" aria-live="polite">
            {selectedIds.length ? (
              <CheckCheck size={16} aria-hidden="true" />
            ) : (
              <Star size={16} aria-hidden="true" />
            )}
            {selectedIds.length
              ? `${tr('Selected', 'Выбрано')}: ${selectedIds.length}`
              : tr('All favorites', 'Все избранные')}
          </span>
          <button
            className="btn collection-picker-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {tr('Cancel', 'Отмена')}
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              setFormError('');
              setOperation('save');
              const success = await setCollections(id, selectedIds);
              setOperation(null);
              if (success) onClose();
              else
                setFormError(
                  tr(
                    'Could not save collections. Try again.',
                    'Не удалось сохранить подборки. Повторите попытку.',
                  ),
                );
            }}
          >
            <Check size={15} aria-hidden="true" />
            {operation === 'save'
              ? tr('Saving...', 'Сохранение...')
              : tr('Save', 'Сохранить')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default function FavoriteActions({
  grenade,
  saved = false,
  onRemoved,
}: {
  grenade: GrenadePreview;
  saved?: boolean;
  onRemoved?: () => void;
}) {
  const { favoriteId, busy, loading, error, toggle, refresh } = useFavorites();
  const { tr } = useI18n();
  const id = favoriteId(grenade, saved);
  const [picker, setPicker] = useState(false);
  const label = id
    ? tr(
        'Remove from favorites and all collections',
        'Удалить из избранного и всех подборок',
      )
    : tr('Save to favorites', 'Добавить в избранное');
  return (
    <span
      className="favorite-actions"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`icon-btn favorite-star ${id ? 'active' : ''}`}
        disabled={busy || loading || error}
        aria-pressed={Boolean(id)}
        aria-label={label}
        data-tip={label}
        onClick={async () => {
          if (await toggle(grenade, saved)) {
            if (id) onRemoved?.();
          }
        }}
      >
        <Star size={16} fill={id ? 'currentColor' : 'none'} />
      </button>
      {id && (
        <button
          type="button"
          className="icon-btn"
          disabled={busy || error}
          aria-label={tr('Manage collections', 'Управлять подборками')}
          data-tip={tr('Manage collections', 'Управлять подборками')}
          onClick={() => setPicker(true)}
        >
          <FolderPlus size={16} />
        </button>
      )}
      {picker && id && (
        <CollectionPicker
          id={id}
          grenade={grenade}
          onClose={() => setPicker(false)}
        />
      )}
      {error && (
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          aria-label={tr('Retry favorites', 'Повторить загрузку избранного')}
          data-tip={tr('Retry favorites', 'Повторить загрузку избранного')}
          onClick={() => void refresh()}
        >
          <RotateCw size={15} />
        </button>
      )}
    </span>
  );
}
