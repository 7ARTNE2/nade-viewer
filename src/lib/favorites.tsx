import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { FavoritesState, GrenadePreview } from '../types/domain';
import {
  createFavoriteCollection,
  deleteFavorite,
  deleteFavoriteCollection,
  getFavoritesState,
  initializeApplication,
  renameFavoriteCollection,
  saveFavorite,
  setFavoriteCollections,
} from './tauri';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';

const emptyState: FavoritesState = {
  collections: [],
  maps: [],
  favorites: {},
  source_matches: {},
};
type FavoritesContextValue = {
  state: FavoritesState;
  revision: number;
  loading: boolean;
  error: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  favoriteId: (grenade: GrenadePreview, saved?: boolean) => number | undefined;
  toggle: (grenade: GrenadePreview, saved?: boolean) => Promise<boolean>;
  createCollection: (name: string) => Promise<number | undefined>;
  renameCollection: (id: number, name: string) => Promise<boolean>;
  deleteCollection: (id: number) => Promise<boolean>;
  setCollections: (id: number, ids: number[]) => Promise<boolean>;
};
const FavoritesContext = createContext<FavoritesContextValue | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(emptyState);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const request = useRef(0);
  const { tr } = useI18n();
  const { showToast } = useToast();
  const refresh = useCallback(async () => {
    const token = ++request.current;
    try {
      await initializeApplication();
      const next = await getFavoritesState();
      if (token !== request.current) return;
      setState(next);
      setError(false);
      setRevision((value) => value + 1);
    } catch (cause) {
      if (token === request.current) setError(true);
      console.error('Unable to refresh favorites', cause);
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const favoriteId = (grenade: GrenadePreview, saved = false) => {
    const id = saved
      ? grenade.id
      : (state.source_matches[grenade.id] ?? grenade.favorite_id);
    return id != null &&
      Object.prototype.hasOwnProperty.call(state.favorites, id)
      ? id
      : undefined;
  };
  const perform = async <T,>(
    work: () => Promise<T>,
    update: (result: T, state: FavoritesState) => FavoritesState,
  ): Promise<T | undefined> => {
    if (lock.current) return undefined;
    lock.current = true;
    ++request.current; // Discard a read started before this mutation.
    setBusy(true);
    try {
      const result = await work();
      setState((current) => update(result, current));
      setRevision((value) => value + 1);
      await refresh();
      return result;
    } catch (cause) {
      console.error(cause);
      showToast(
        tr('Could not update favorites', 'Не удалось изменить избранное'),
        { tone: 'error' },
      );
      return undefined;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const toggle = async (grenade: GrenadePreview, saved = false) => {
    const id = favoriteId(grenade, saved);
    if (saved && !id) return false;
    const result = await perform(
      async () => {
        if (id) {
          await deleteFavorite(id);
          return id;
        }
        return saveFavorite(grenade.id);
      },
      (result, current) => {
        const favorites = { ...current.favorites };
        const matches = { ...current.source_matches };
        if (id) {
          delete favorites[id];
          for (const key of Object.keys(matches))
            if (matches[Number(key)] === id) delete matches[Number(key)];
        } else {
          favorites[result] = [];
          matches[grenade.id] = result;
        }
        return { ...current, favorites, source_matches: matches };
      },
    );
    if (result === undefined) return false;
    showToast(
      id
        ? tr('Removed from favorites', 'Удалено из избранного')
        : tr('Saved to favorites', 'Добавлено в избранное'),
      { tone: 'success' },
    );
    return true;
  };
  const createCollection = (name: string) =>
    perform(
      () => createFavoriteCollection(name),
      (id, current) => ({
        ...current,
        collections: [
          ...current.collections,
          { id, name: name.trim(), grenade_count: 0 },
        ],
      }),
    );
  const renameCollection = async (id: number, name: string) =>
    (await perform(
      async () => {
        await renameFavoriteCollection(id, name);
        return true;
      },
      (_, current) => ({
        ...current,
        collections: current.collections.map((c) =>
          c.id === id ? { ...c, name: name.trim() } : c,
        ),
      }),
    )) === true;
  const deleteCollection = async (id: number) =>
    (await perform(
      async () => {
        await deleteFavoriteCollection(id);
        return true;
      },
      (_, current) => ({
        ...current,
        collections: current.collections.filter((c) => c.id !== id),
        favorites: Object.fromEntries(
          Object.entries(current.favorites).map(([key, ids]) => [
            key,
            ids.filter((value) => value !== id),
          ]),
        ),
      }),
    )) === true;
  const setCollections = async (id: number, ids: number[]) =>
    (await perform(
      async () => {
        await setFavoriteCollections(id, ids);
        return true;
      },
      (_, current) => ({
        ...current,
        favorites: { ...current.favorites, [id]: ids },
      }),
    )) === true;
  return (
    <FavoritesContext.Provider
      value={{
        state,
        revision,
        loading,
        error,
        busy,
        refresh,
        favoriteId,
        toggle,
        createCollection,
        renameCollection,
        deleteCollection,
        setCollections,
      }}
    >
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const context = useContext(FavoritesContext);
  if (!context) throw new Error('FavoritesProvider is missing');
  return context;
}
