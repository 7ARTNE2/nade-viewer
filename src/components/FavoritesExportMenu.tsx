import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  Globe,
  Map,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { exportFavoritesShare } from '../lib/tauri';
import { formatNumber } from '../lib/format';
import type {
  FavoriteCollection,
  FavoriteShareScope,
  MapSummary,
} from '../types/domain';
import { useToast } from './Toast';

type Props = {
  map: string;
  maps: MapSummary[];
  collections: FavoriteCollection[];
  selectedCollectionId?: number;
  disabled: boolean;
};

export default function FavoritesExportMenu({
  map,
  maps,
  collections,
  selectedCollectionId,
  disabled,
}: Props) {
  const { tr } = useI18n();
  const { showToast } = useToast();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'scopes' | 'collections'>('scopes');
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 300,
    maxHeight: 400,
  });
  const mapCollections = collections
    .filter((c) => c.map === map)
    .sort(
      (a, b) =>
        Number(b.id === selectedCollectionId) -
        Number(a.id === selectedCollectionId),
    );
  const selected = mapCollections.find((c) => c.id === selectedCollectionId);
  const currentMap = maps.find((m) => m.name === map);
  const total = maps.reduce((count, item) => count + item.grenade_count, 0);
  const hasCollections = collections.some((c) => c.map !== null);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus)
      window.requestAnimationFrame(() =>
        triggerRef.current?.focus({ preventScroll: true }),
      );
  };
  const calculatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 20);
    const top = Math.max(
      10,
      Math.min(rect.bottom + 6, window.innerHeight - 150),
    );
    setPosition({
      left: Math.max(
        10,
        Math.min(rect.right - width, window.innerWidth - width - 10),
      ),
      top,
      width,
      maxHeight: Math.max(120, window.innerHeight - top - 10),
    });
  };
  const openMenu = () => {
    if (disabled || lock.current) return;
    calculatePosition();
    setView('scopes');
    setError('');
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [open, view]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    const onViewportChange = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      if (event.type === 'scroll') calculatePosition();
      else setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const share = async (scope: FavoriteShareScope) => {
    if (lock.current || disabled) return;
    lock.current = true;
    setSharing(true);
    setError('');
    try {
      const path = await exportFavoritesShare(scope);
      if (path)
        showToast(tr('Favorites file saved', 'Файл избранного сохранён'), {
          tone: 'success',
        });
      close(true);
    } catch (cause) {
      console.error('Unable to export favorites', cause);
      setError(
        tr(
          'Could not export favorites. Try again.',
          'Не удалось экспортировать избранное. Повторите попытку.',
        ),
      );
      setOpen(true);
    } finally {
      lock.current = false;
      setSharing(false);
    }
  };

  if (total === 0 && !hasCollections) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="favorites-export-trigger"
        disabled={disabled || sharing}
        aria-label={tr('Export favorites', 'Экспорт избранного')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={sharing}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <Download size={15} aria-hidden="true" />
        <span>
          {sharing ? tr('Saving…', 'Сохранение…') : tr('Export', 'Экспорт')}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="favorites-export-menu"
            role="menu"
            aria-label={
              view === 'collections'
                ? tr('Export collection', 'Экспорт подборки')
                : tr('Export favorites', 'Экспорт избранного')
            }
            aria-busy={sharing}
            style={position}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget) &&
                !triggerRef.current?.contains(event.relatedTarget)
              )
                close();
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' ||
                (event.key === 'ArrowLeft' && view === 'collections')
              ) {
                event.preventDefault();
                if (view === 'collections') setView('scopes');
                else close(true);
              } else if (
                ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
              ) {
                event.preventDefault();
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ),
                ];
                const index = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          items.length) %
                        items.length;
                items[next]?.focus({ preventScroll: true });
              } else if (event.key === 'Tab') close();
            }}
          >
            {view === 'collections' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="favorites-export-back"
                  disabled={sharing}
                  onClick={() => setView('scopes')}
                >
                  <ArrowLeft size={15} aria-hidden="true" />
                  {tr('Back', 'Назад')}
                </button>
                <div className="favorites-export-heading">
                  {tr('Choose a collection', 'Выберите подборку')} ·{' '}
                  {currentMap?.label ?? map}
                </div>
                {mapCollections.map((collection) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={collection.id}
                    disabled={sharing}
                    onClick={() =>
                      void share({
                        kind: 'collection',
                        collection_id: collection.id,
                      })
                    }
                  >
                    <Folder size={16} aria-hidden="true" />
                    <span>
                      <strong>{collection.name}</strong>
                      {collection.id === selectedCollectionId && (
                        <small>
                          {tr('Selected collection', 'Выбранная подборка')}
                        </small>
                      )}
                    </span>
                    <b>{formatNumber(collection.grenade_count)}</b>
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="favorites-export-heading">
                  {tr('Export to file', 'Экспорт в файл')}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  disabled={sharing || !mapCollections.length}
                  onClick={() => setView('collections')}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') {
                      event.preventDefault();
                      setView('collections');
                    }
                  }}
                >
                  <Folder size={16} aria-hidden="true" />
                  <span>
                    <strong>{tr('Collection…', 'Подборка…')}</strong>
                    <small>
                      {selected?.name ??
                        tr(
                          'Choose a collection from this map',
                          'Выбрать подборку этой карты',
                        )}
                    </small>
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={
                    sharing ||
                    !(currentMap?.grenade_count || mapCollections.length)
                  }
                  onClick={() => void share({ kind: 'map', map })}
                >
                  <Map size={16} aria-hidden="true" />
                  <span>
                    <strong>
                      {tr('All favorites on this map', 'Все избранные карты')}
                    </strong>
                    <small>{currentMap?.label ?? map}</small>
                  </span>
                  <b>{formatNumber(currentMap?.grenade_count ?? 0)}</b>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={sharing}
                  onClick={() => void share({ kind: 'all' })}
                >
                  <Globe size={16} aria-hidden="true" />
                  <span>
                    <strong>{tr('All maps', 'Все карты')}</strong>
                    <small>
                      {tr(
                        'All favorites and collections',
                        'Всё избранное и подборки',
                      )}
                    </small>
                  </span>
                  <b>{formatNumber(total)}</b>
                </button>
              </>
            )}
            {sharing && (
              <p className="favorites-export-status" role="status">
                {tr('Preparing file…', 'Подготовка файла…')}
              </p>
            )}
            {error && (
              <p className="favorites-share-error" role="alert">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
