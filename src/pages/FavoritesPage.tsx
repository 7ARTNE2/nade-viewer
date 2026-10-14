import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Map, Pencil, Plus, Trash2, X } from 'lucide-react';
import MapWorkspace from './MapWorkspace';
import DestructiveConfirmDialog from '../components/DestructiveConfirmDialog';
import { useFavorites } from '../lib/favorites';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';
import type { FavoriteCollection, MapSummary } from '../types/domain';
import { assetUrl } from '../lib/tauri';
import { formatNumber } from '../lib/format';

function readSelection(): { map: string; collectionId?: number } {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem('nadeviewer.favorites-selection') ?? '{}',
    );
    return {
      map: typeof value.map === 'string' ? value.map : '',
      collectionId:
        Number.isInteger(value.collectionId) && value.collectionId > 0
          ? value.collectionId
          : undefined,
    };
  } catch {
    return { map: '' };
  }
}

function CollectionNameDialog({
  collection,
  map,
  maps,
  onClose,
}: {
  collection: FavoriteCollection | null;
  map: string;
  maps: MapSummary[];
  onClose: () => void;
}) {
  const { busy, createCollection, renameCollection, assignCollectionMap } =
    useFavorites();
  const { tr } = useI18n();
  const [name, setName] = useState(collection?.name ?? '');
  const legacy = collection?.map === null;
  const [assignedMap, setAssignedMap] = useState(
    legacy ? '' : (collection?.map ?? map),
  );
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
          const result = legacy
            ? await assignCollectionMap(collection.id, assignedMap, name)
            : collection
              ? await renameCollection(collection.id, name)
              : (await createCollection(name, assignedMap)) !== undefined;
          if (result) onClose();
        }}
      >
        <div className="favorites-dialog-heading">
          <h2 id="collection-name-title">
            {legacy
              ? tr('Choose collection map', 'Выбрать карту подборки')
              : collection
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
        {legacy ? (
          <label className="favorites-field">
            <span>{tr('Map', 'Карта')}</span>
            <select
              value={assignedMap}
              disabled={busy}
              onChange={(event) => setAssignedMap(event.target.value)}
              required
            >
              <option value="">{tr('Select map', 'Выберите карту')}</option>
              {maps.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="favorites-dialog-map">
            {maps.find((item) => item.name === assignedMap)?.label ??
              assignedMap}
          </p>
        )}
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
          <button
            className="btn primary"
            disabled={busy || !name.trim() || !assignedMap}
          >
            {busy ? tr('Saving…', 'Сохранение…') : tr('Save', 'Сохранить')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export default function FavoritesPage() {
  const { state, maps, loading, error, busy, refresh, deleteCollection } =
    useFavorites();
  const { tr } = useI18n();
  const [selection, setSelection] = useState(readSelection);
  const [editing, setEditing] = useState<
    FavoriteCollection | null | undefined
  >();
  const [deleting, setDeleting] = useState<FavoriteCollection | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const selected = state.collections.find(
    (c) => c.id === selection.collectionId && c.map === selection.map,
  );
  useEffect(() => {
    if (loading || error) return;
    setSelection((current) => {
      const map = maps.some((item) => item.name === current.map)
        ? current.map
        : (maps.find((item) => item.grenade_count > 0)?.name ??
          maps[0]?.name ??
          '');
      const collectionId =
        current.collectionId !== undefined &&
        !state.collections.some(
          (c) => c.id === current.collectionId && c.map === map,
        )
          ? undefined
          : current.collectionId;
      return collectionId === current.collectionId && map === current.map
        ? current
        : { map, collectionId };
    });
  }, [state, maps, loading, error]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        'nadeviewer.favorites-selection',
        JSON.stringify(selection),
      );
    } catch {
      /* Storage may be disabled. */
    }
  }, [selection]);

  const controls = (
    <div className="favorites-map-controls">
      <select
        className="map-favorites-collection-trigger"
        aria-label={tr('Collection', 'Подборка')}
        value={selection.collectionId ?? ''}
        disabled={loading || error}
        onChange={(event) =>
          setSelection((current) => ({
            ...current,
            collectionId: event.target.value
              ? Number(event.target.value)
              : undefined,
          }))
        }
      >
        <option value="">{tr('All favorites', 'Все избранные')}</option>
        {state.collections
          .filter((c) => c.map === selection.map)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <button
        className="icon-btn"
        disabled={busy || loading || error || !selection.map}
        onClick={() => setEditing(null)}
        aria-label={tr('Create collection', 'Создать подборку')}
      >
        <Plus size={16} />
      </button>
      {selected && (
        <>
          <button
            className="icon-btn"
            disabled={busy || error}
            onClick={() => setEditing(selected)}
            aria-label={tr('Rename collection', 'Переименовать подборку')}
          >
            <Pencil size={16} />
          </button>
          <button
            className="icon-btn"
            disabled={busy || error}
            onClick={() => {
              setDeleting(selected);
              setDeleteError('');
            }}
            aria-label={tr('Delete collection', 'Удалить подборку')}
          >
            <Trash2 size={16} />
          </button>
        </>
      )}
    </div>
  );
  return (
    <div className="favorites-map-page">
      <nav
        className="favorites-map-strip"
        aria-label={tr('Saved maps', 'Карты избранного')}
      >
        {maps.map((map) => (
          <button
            key={map.name}
            type="button"
            className={`favorites-map-tab ${selection.map === map.name ? 'active' : ''}`}
            aria-pressed={selection.map === map.name}
            disabled={loading || error}
            onClick={() => {
              if (map.name !== selection.map) setSelection({ map: map.name });
            }}
          >
            {map.preview_image_path ? (
              <img src={assetUrl(map.preview_image_path)} alt="" />
            ) : (
              <Map size={18} aria-hidden="true" />
            )}
            <span>{map.label}</span>
            <b>{formatNumber(map.grenade_count)}</b>
          </button>
        ))}
      </nav>
      {state.collections.some((c) => c.map === null) && (
        <div className="favorites-unassigned">
          <span>
            {tr(
              'Choose a map for empty collections',
              'Выберите карту для пустых подборок',
            )}
          </span>
          {state.collections
            .filter((c) => c.map === null)
            .map((c) => (
              <button
                key={c.id}
                className="btn"
                disabled={busy || error}
                onClick={() => setEditing(c)}
              >
                {c.name}
              </button>
            ))}
        </div>
      )}
      {error && (
        <div className="panel-load-error" role="alert">
          <span>
            {tr('Unable to load favorites', 'Не удалось загрузить избранное')}
          </span>
          <button className="btn" onClick={() => void refresh()}>
            {tr('Retry', 'Повторить')}
          </button>
        </div>
      )}
      {loading ? (
        <div className="empty-note">
          {tr('Loading favorites', 'Загрузка избранного')}
        </div>
      ) : (
        selection.map && (
          <MapWorkspace
            key={`${selection.collectionId ?? 'all'}:${selection.map}`}
            source={{
              kind: 'favorites',
              mapName: selection.map,
              collectionId: selection.collectionId,
            }}
            toolbar={controls}
          />
        )
      )}
      {editing !== undefined && (
        <CollectionNameDialog
          collection={editing}
          map={selection.map}
          maps={maps}
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
              setSelection((current) => ({
                ...current,
                collectionId: undefined,
              }));
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
