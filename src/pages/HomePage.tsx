import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, History, Plus, Search } from 'lucide-react';
import { assetUrl, getMaps, getRecentlyViewedGrenades } from '../lib/tauri';
import { formatNumber, grenadeLabel } from '../lib/format';
import type { MapSummary, ViewedGrenade } from '../types/domain';
import { useI18n } from '../i18n';

type HomePageProps = {
  activeImportId?: number | null;
};

export default function HomePage({ activeImportId }: HomePageProps) {
  const { tr, count } = useI18n();
  const navigate = useNavigate();
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [recentlyViewed, setRecentlyViewed] = useState<ViewedGrenade[]>([]);
  const [search, setSearch] = useState('');
  const [mapsLoading, setMapsLoading] = useState(true);
  const mapsRequestRef = useRef(0);

  useEffect(() => {
    const requestId = mapsRequestRef.current + 1;
    mapsRequestRef.current = requestId;
    setMapsLoading(true);
    Promise.all([
      getMaps().catch(() => [] as MapSummary[]),
      getRecentlyViewedGrenades(10).catch(() => [] as ViewedGrenade[]),
    ])
      .then(([nextMaps, nextRecentlyViewed]) => {
        if (mapsRequestRef.current === requestId) {
          setMaps(Array.isArray(nextMaps) ? nextMaps : []);
          setRecentlyViewed(
            Array.isArray(nextRecentlyViewed) ? nextRecentlyViewed : [],
          );
          setMapsLoading(false);
        }
      })
      .catch(() => {
        if (mapsRequestRef.current === requestId) {
          setMaps([]);
          setRecentlyViewed([]);
          setMapsLoading(false);
        }
      });
  }, [activeImportId]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? maps.filter(
          (map) =>
            String(map.label ?? '')
              .toLowerCase()
              .includes(q) ||
            String(map.name ?? '')
              .toLowerCase()
              .includes(q),
        )
      : maps;
  }, [maps, search]);

  const total = maps.reduce((sum, map) => sum + map.grenade_count, 0);
  return (
    <div className="home-view">
      <section className="home-sidebar">
        <div className="eyebrow">{tr('Grenade database', 'База гранат')}</div>
        <h1>{tr('Choose a map', 'Выберите карту')}</h1>
        <p className="muted">
          {tr(
            'Explore lineups by landing zone, throw position and trajectory.',
            'Изучайте раскидки по точке приземления, позиции броска и траектории.',
          )}
        </p>
        <div className="library-stats">
          <div className="stat-line">
            <span>{formatNumber(maps.length)}</span>
            <small>{tr('Maps', 'Карты')}</small>
          </div>
          <div className="stat-line">
            <span>{formatNumber(total)}</span>
            <small>{tr('Lineups', 'Раскидки')}</small>
          </div>
        </div>
        <button
          className="library-import-btn"
          type="button"
          onClick={() => navigate('/import')}
        >
          <Plus size={15} /> {tr('Import library', 'Импорт библиотеки')}
        </button>
        <div className="recent-history">
          <div className="recent-history-title">
            <span>
              <History size={14} />{' '}
              {tr('Recently viewed', 'Недавно просмотренные')}
            </span>
            {recentlyViewed.length ? (
              <small>{formatNumber(recentlyViewed.length)}</small>
            ) : null}
          </div>
          {recentlyViewed.length ? (
            <div className="recent-history-list">
              {recentlyViewed.map((grenade) => (
                <button
                  key={grenade.id}
                  type="button"
                  onClick={() => navigate(`/grenade/${grenade.id}`)}
                >
                  <span
                    className={`type-pill ${String(grenade.grenade_type).toLowerCase()}`}
                  >
                    {grenadeLabel(grenade.grenade_type)}
                  </span>
                  <span className="recent-history-main">
                    <strong>
                      {grenade.thrower ||
                        `${tr('Grenade', 'Граната')} #${grenade.id}`}
                    </strong>
                    <small>
                      {grenade.map} / {grenade.side}
                    </small>
                  </span>
                  {grenade.view_count > 1 ? (
                    <span className="recent-history-count">
                      {formatNumber(grenade.view_count)}x
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-history-empty">
              {tr('No grenade views yet.', 'Просмотренных гранат пока нет.')}
            </div>
          )}
        </div>
      </section>

      <section className="map-grid-section">
        <div className="library-heading">
          <div>
            <span className="eyebrow">{tr('Map pool', 'Набор карт')}</span>
            <strong>
              {count(
                visible.length,
                'map available',
                'maps available',
                'карта доступна',
                'карты доступны',
                'карт доступно',
              )}
            </strong>
          </div>
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tr('Find a map', 'Найти карту')}
            />
          </div>
        </div>
        <div className="map-grid">
          {mapsLoading
            ? Array.from({ length: 8 }, (_, index) => (
                <div className="map-tile map-tile-skeleton" key={index}>
                  <div className="map-orb" />
                  <div className="map-tile-footer">
                    <span>
                      <i />
                      <small />
                    </span>
                  </div>
                </div>
              ))
            : visible.map((map) => (
                <button
                  key={map.name}
                  className="map-tile"
                  data-tour={
                    map.name === maps[0]?.name ? 'map-target' : 'map-tile'
                  }
                  data-map-key={String(map.name)
                    .toLowerCase()
                    .replace(/^de_/, '')}
                  onClick={() =>
                    navigate(`/map/${encodeURIComponent(map.name)}`)
                  }
                >
                  <div className="map-orb">
                    {map.preview_image_path ? (
                      <img src={assetUrl(map.preview_image_path)} alt="" />
                    ) : (
                      <span>
                        {String(map.label || map.name || '??').slice(0, 2)}
                      </span>
                    )}
                  </div>
                  <div className="map-tile-footer">
                    <span>
                      <strong>{map.label}</strong>
                      <small>
                        {count(
                          map.grenade_count,
                          'lineup',
                          'lineups',
                          'раскидка',
                          'раскидки',
                          'раскидок',
                        )}
                      </small>
                    </span>
                    <ArrowUpRight size={17} />
                  </div>
                </button>
              ))}
        </div>
        {!mapsLoading && !visible.length ? (
          <div className="map-grid-empty">
            <strong>
              {search.trim()
                ? tr(
                    'No maps match this search',
                    'Карты по этому запросу не найдены',
                  )
                : tr(
                    'This library has no maps yet',
                    'В этой библиотеке пока нет карт',
                  )}
            </strong>
            <p>
              {search.trim()
                ? tr(
                    `Nothing matched "${search.trim()}". Try another map name.`,
                    `По запросу «${search.trim()}» ничего не найдено. Попробуйте другое название карты.`,
                  )
                : tr(
                    'Import a grenade library with map data to start exploring lineups.',
                    'Импортируйте библиотеку гранат с данными карт, чтобы начать изучение раскидок.',
                  )}
            </p>
            <button
              className="btn"
              type="button"
              onClick={() =>
                search.trim() ? setSearch('') : navigate('/import')
              }
            >
              {search.trim()
                ? tr('Clear search', 'Сбросить поиск')
                : tr('Import library', 'Импортировать библиотеку')}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
