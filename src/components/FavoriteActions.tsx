import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, RotateCw, Star, X } from 'lucide-react';
import type { GrenadePreview } from '../types/domain';
import { useFavorites } from '../lib/favorites';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';

function CollectionPicker({
  id,
  map,
  onClose,
}: {
  id: number;
  map: string;
  onClose: () => void;
}) {
  const { state, busy, setCollections, createCollection } = useFavorites();
  const { tr } = useI18n();
  const [selected, setSelected] = useState(state.favorites[id] ?? []);
  const [name, setName] = useState('');
  const collections = state.collections.filter((c) => c.map === map);
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const ref = useModalAccessibility<HTMLDivElement>(true, close);
  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="favorites-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-picker-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="favorites-dialog-heading">
          <h2 id="collection-picker-title">
            {tr('Add to collections', 'Добавить в подборки')}
          </h2>
          <button
            className="icon-btn"
            disabled={busy}
            onClick={onClose}
            aria-label={tr('Close', 'Закрыть')}
          >
            <X size={16} />
          </button>
        </div>
        <p>
          {tr(
            'Removing a collection check keeps the grenade in All favorites.',
            'Снятие отметки подборки оставляет гранату во «Всех избранных».',
          )}
        </p>
        <div className="favorites-collection-checks">
          {collections.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
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
              <span>{c.name}</span>
              <small>{c.grenade_count}</small>
            </label>
          ))}
          {!collections.length && (
            <p>
              {tr(
                'Create your first collection below.',
                'Создайте первую подборку ниже.',
              )}
            </p>
          )}
        </div>
        <form
          className="favorites-inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const created = await createCollection(name, map);
            if (created !== undefined) {
              setName('');
              setSelected((ids) => [...ids, created]);
            }
          }}
        >
          <input
            aria-label={tr('New collection name', 'Название новой подборки')}
            placeholder={tr('New collection', 'Новая подборка')}
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button className="btn" disabled={busy || !name.trim()}>
            {tr('Create', 'Создать')}
          </button>
        </form>
        <div className="favorites-dialog-footer">
          <button className="btn" disabled={busy} onClick={onClose}>
            {tr('Cancel', 'Отмена')}
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              if (await setCollections(id, selected)) onClose();
            }}
          >
            {busy ? tr('Saving…', 'Сохранение…') : tr('Save', 'Сохранить')}
          </button>
        </div>
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
          map={grenade.map}
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
