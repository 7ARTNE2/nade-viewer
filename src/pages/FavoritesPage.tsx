import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import GrenadeList from '../components/GrenadeList';
import DestructiveConfirmDialog from '../components/DestructiveConfirmDialog';
import { useFavorites } from '../lib/favorites';
import { listFavorites } from '../lib/tauri';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';
import type { FavoriteCollection, FavoriteList } from '../types/domain';

function CollectionNameDialog({
  collection,
  onClose,
}: {
  collection: FavoriteCollection | null;
  onClose: () => void;
}) {
  const { busy, createCollection, renameCollection } = useFavorites();
  const { tr } = useI18n();
  const [name, setName] = useState(collection?.name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const ref = useModalAccessibility<HTMLFormElement>(true, close, inputRef);
  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <form
        ref={ref}
        className="favorites-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-name-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          const result = collection
            ? await renameCollection(collection.id, name)
            : (await createCollection(name)) !== undefined;
          if (result) onClose();
        }}
      >
        <div className="favorites-dialog-heading">
          <h2 id="collection-name-title">
            {collection
              ? tr('Rename collection', 'Переименовать подборку')
              : tr('New collection', 'Новая подборка')}
          </h2>
          <button
            type="button"
            className="icon-btn"
            disabled={busy}
            onClick={onClose}
            aria-label={tr('Close', 'Закрыть')}
          >
            <X size={16} />
          </button>
        </div>
        <label className="favorites-field">
          <span>{tr('Name', 'Название')}</span>
          <input
            ref={inputRef}
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="favorites-dialog-footer">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            {tr('Cancel', 'Отмена')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? tr('Saving…', 'Сохранение…') : tr('Save', 'Сохранить')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export default function FavoritesPage() {
  const location = useLocation();
  const {
    state,
    revision,
    loading: stateLoading,
    error: stateError,
    busy,
    refresh,
    deleteCollection,
  } = useFavorites();
  const { tr } = useI18n();
  const [collectionId, setCollectionId] = useState<number | undefined>();
  const [map, setMap] = useState('');
  const [type, setType] = useState('all');
  const [side, setSide] = useState('Any');
  const [search, setSearch] = useState(() => {
    const value = (location.state as { search?: unknown } | null)?.search;
    return typeof value === 'string' ? value : '';
  });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<FavoriteList>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<
    FavoriteCollection | null | undefined
  >();
  const [deleting, setDeleting] = useState<FavoriteCollection | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const request = useRef(0);
  const selected = state.collections.find((c) => c.id === collectionId);

  useEffect(() => {
    if (
      !stateLoading &&
      !stateError &&
      collectionId !== undefined &&
      !state.collections.some((c) => c.id === collectionId)
    ) {
      setCollectionId(undefined);
      setPage(0);
    }
    if (!stateLoading && !stateError && map && !state.maps.includes(map)) {
      setMap('');
      setPage(0);
    }
  }, [collectionId, map, state, stateLoading, stateError]);

  useEffect(() => {
    const token = ++request.current;
    setLoading(true);
    setError(false);
    if (stateLoading) return;
    const timer = window.setTimeout(() => {
      listFavorites({
        map,
        grenade_type: type,
        side,
        search,
        collection_id: collectionId,
        limit: 30,
        offset: page * 30,
      })
        .then((next) => {
          if (request.current !== token) return;
          if (page > 0 && page * 30 >= next.total) {
            setPage(Math.max(0, Math.ceil(next.total / 30) - 1));
            return;
          }
          setData(next);
        })
        .catch((cause) => {
          console.error(cause);
          if (request.current === token) setError(true);
        })
        .finally(() => {
          if (request.current === token) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      ++request.current;
    };
  }, [
    collectionId,
    map,
    type,
    side,
    search,
    page,
    revision,
    retry,
    stateLoading,
  ]);

  const reset = () => {
    setMap('');
    setType('all');
    setSide('Any');
    setSearch('');
    setPage(0);
  };
  return (
    <div className="favorites-workspace">
      <aside className="favorites-sidebar">
        <div className="eyebrow">Nade Viewer</div>
        <h1>
          <Star size={24} />
          {tr('Favorites', 'Избранное')}
        </h1>
        <p>
          {tr(
            'Your saved lineups stay here when libraries change.',
            'Сохранённые раскидки остаются здесь при смене библиотек.',
          )}
        </p>
        <button
          className={`favorites-collection ${collectionId === undefined ? 'active' : ''}`}
          aria-pressed={collectionId === undefined}
          onClick={() => {
            setCollectionId(undefined);
            setPage(0);
          }}
        >
          <span>{tr('All favorites', 'Все избранные')}</span>
          <b>{Object.keys(state.favorites).length}</b>
        </button>
        <div className="favorites-sidebar-heading">
          <strong>{tr('Collections', 'Подборки')}</strong>
          <button
            className="icon-btn"
            disabled={busy || stateLoading || stateError}
            onClick={() => setEditing(null)}
            aria-label={tr('Create collection', 'Создать подборку')}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="favorites-collections">
          {state.collections.map((c) => (
            <button
              key={c.id}
              className={`favorites-collection ${collectionId === c.id ? 'active' : ''}`}
              aria-pressed={collectionId === c.id}
              onClick={() => {
                setCollectionId(c.id);
                setPage(0);
              }}
            >
              <span>{c.name}</span>
              <b>{c.grenade_count}</b>
            </button>
          ))}
        </div>
        {!state.collections.length && !stateLoading && (
          <small>
            {tr(
              'Organize lineups by map or practice routine.',
              'Соберите раскидки по картам или задачам тренировки.',
            )}
          </small>
        )}
      </aside>
      <section className="favorites-content">
        <header className="favorites-content-heading">
          <div>
            <h2>{selected?.name ?? tr('All favorites', 'Все избранные')}</h2>
            <p>
              {tr(
                'Independent copies of saved grenades',
                'Независимые копии сохранённых гранат',
              )}
            </p>
          </div>
          {selected && (
            <div className="favorite-actions">
              <button
                className="icon-btn"
                disabled={busy || stateError}
                onClick={() => setEditing(selected)}
                aria-label={tr('Rename collection', 'Переименовать подборку')}
              >
                <Pencil size={16} />
              </button>
              <button
                className="icon-btn"
                disabled={busy || stateError}
                onClick={() => {
                  setDeleting(selected);
                  setDeleteError('');
                }}
                aria-label={tr('Delete collection', 'Удалить подборку')}
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}
        </header>
        {(stateError || error) && (
          <div className="panel-load-error" role="alert">
            <span>
              {tr('Unable to load favorites', 'Не удалось загрузить избранное')}
            </span>
            <button
              className="btn"
              onClick={() => {
                void refresh();
                setRetry((v) => v + 1);
              }}
            >
              {tr('Retry', 'Повторить')}
            </button>
          </div>
        )}
        <div className="favorites-filters">
          <label className="favorites-search">
            <Search size={15} />
            <input
              type="search"
              aria-label={tr('Search favorites', 'Поиск в избранном')}
              placeholder={tr(
                'Player, team, coordinates…',
                'Игрок, команда, координаты…',
              )}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="favorites-field">
            <span>{tr('Map', 'Карта')}</span>
            <select
              value={map}
              onChange={(event) => {
                setMap(event.target.value);
                setPage(0);
              }}
            >
              <option value="">{tr('All maps', 'Все карты')}</option>
              {state.maps.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="favorites-field">
            <span>{tr('Type', 'Тип')}</span>
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setPage(0);
              }}
            >
              <option value="all">{tr('All types', 'Все типы')}</option>
              <option value="smoke">{tr('Smoke', 'Дым')}</option>
              <option value="flash">{tr('Flash', 'Флешка')}</option>
              <option value="molotov">{tr('Molotov', 'Молотов')}</option>
              <option value="HE">HE</option>
            </select>
          </label>
          <label className="favorites-field">
            <span>{tr('Side', 'Сторона')}</span>
            <select
              value={side}
              onChange={(event) => {
                setSide(event.target.value);
                setPage(0);
              }}
            >
              <option value="Any">{tr('Any', 'Любая')}</option>
              <option>T</option>
              <option>CT</option>
            </select>
          </label>
          <button className="btn" onClick={reset}>
            {tr('Reset', 'Сбросить')}
          </button>
        </div>
        <div className="section-title">
          <span>{tr('Saved lineups', 'Сохранённые раскидки')}</span>
          <span className="section-count">{data.total}</span>
        </div>
        {!error && (
          <GrenadeList
            grenades={data.items}
            saved
            showMap
            showCopy
            loading={loading || stateLoading}
            emptyLabel={
              Object.keys(state.favorites).length
                ? tr(
                    'No saved lineups match these filters or collection.',
                    'В этой подборке или с такими фильтрами нет сохранённых раскидок.',
                  )
                : tr(
                    'Click the star on a grenade to save it here.',
                    'Нажмите звёздочку у гранаты, чтобы сохранить её здесь.',
                  )
            }
          />
        )}
        {data.total > 30 && (
          <div className="panel-pager">
            <button
              disabled={loading || page === 0}
              onClick={() => setPage((v) => v - 1)}
              aria-label={tr('Previous favorites', 'Предыдущие избранные')}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {page * 30 + 1}–{Math.min((page + 1) * 30, data.total)} /{' '}
              {data.total}
            </span>
            <button
              disabled={loading || (page + 1) * 30 >= data.total}
              onClick={() => setPage((v) => v + 1)}
              aria-label={tr('Next favorites', 'Следующие избранные')}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </section>
      {editing !== undefined && (
        <CollectionNameDialog
          collection={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <DestructiveConfirmDialog
          eyebrow={tr('Collection', 'Подборка')}
          title={tr('Delete collection?', 'Удалить подборку?')}
          description={tr(
            'Saved grenades will remain in All favorites and other collections.',
            'Сохранённые гранаты останутся во «Всех избранных» и других подборках.',
          )}
          metadata={<strong>{deleting.name}</strong>}
          confirmLabel={tr('Delete collection', 'Удалить подборку')}
          pendingLabel={tr('Deleting…', 'Удаление…')}
          busy={busy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (await deleteCollection(deleting.id)) {
              setDeleting(null);
              setCollectionId(undefined);
              setPage(0);
            } else
              setDeleteError(
                tr(
                  'Could not delete collection',
                  'Не удалось удалить подборку',
                ),
              );
          }}
        />
      )}
    </div>
  );
}
