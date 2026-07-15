import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUpRight, History, Plus, Search, X } from "lucide-react";
import { assetUrl, getMaps, getRecentlyViewedGrenades } from "../lib/tauri";
import { formatNumber, grenadeLabel } from "../lib/format";
import type { ImportSummary, MapSummary, ViewedGrenade } from "../types/domain";
import ImportPage from "./ImportPage";

type HomePageProps = {
  activeImportId?: number | null;
  onImported: () => Promise<void>;
  lastImport: ImportSummary | null;
};

export default function HomePage({ activeImportId, onImported, lastImport }: HomePageProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [recentlyViewed, setRecentlyViewed] = useState<ViewedGrenade[]>([]);
  const [search, setSearch] = useState("");
  const mapsRequestRef = useRef(0);

  useEffect(() => {
    const requestId = mapsRequestRef.current + 1;
    mapsRequestRef.current = requestId;
    Promise.all([
      getMaps().catch(() => [] as MapSummary[]),
      getRecentlyViewedGrenades(8).catch(() => [] as ViewedGrenade[]),
    ])
      .then(([nextMaps, nextRecentlyViewed]) => {
        if (mapsRequestRef.current === requestId) {
          setMaps(nextMaps);
          setRecentlyViewed(nextRecentlyViewed);
        }
      })
      .catch(() => {
        if (mapsRequestRef.current === requestId) {
          setMaps([]);
          setRecentlyViewed([]);
        }
      });
  }, [activeImportId]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? maps.filter((map) => map.label.toLowerCase().includes(q) || map.name.toLowerCase().includes(q)) : maps;
  }, [maps, search]);

  const total = maps.reduce((sum, map) => sum + map.grenade_count, 0);
  const importOpen = !activeImportId || searchParams.get("import") === "1";
  const closeImport = () => {
    if (!activeImportId) return;
    setSearchParams({}, { replace: true });
  };

  return (
    <div className="home-view">
      <section className="home-sidebar">
        <div className="eyebrow">Grenade database</div>
        <h1>Choose<br />a map</h1>
        <p className="muted">Explore lineups by landing zone, throw position and trajectory.</p>
        <div className="library-stats">
          <div className="stat-line"><span>{formatNumber(maps.length)}</span><small>Maps</small></div>
          <div className="stat-line"><span>{formatNumber(total)}</span><small>Lineups</small></div>
        </div>
        <button className="library-import-btn" type="button" onClick={() => setSearchParams({ import: "1" })}>
          <Plus size={15} /> Import library
        </button>
        <div className="recent-history">
          <div className="recent-history-title">
            <span><History size={14} /> Recently viewed</span>
            {recentlyViewed.length ? <small>{formatNumber(recentlyViewed.length)}</small> : null}
          </div>
          {recentlyViewed.length ? (
            <div className="recent-history-list">
              {recentlyViewed.map((grenade) => (
                <button key={grenade.id} type="button" onClick={() => navigate(`/grenade/${grenade.id}`)}>
                  <span className={`type-pill ${String(grenade.grenade_type).toLowerCase()}`}>{grenadeLabel(grenade.grenade_type)}</span>
                  <span className="recent-history-main">
                    <strong>{grenade.thrower || `Grenade #${grenade.id}`}</strong>
                    <small>{grenade.map} / {grenade.side}</small>
                  </span>
                  {grenade.view_count > 1 ? <span className="recent-history-count">{formatNumber(grenade.view_count)}x</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-history-empty">No grenade views yet.</div>
          )}
        </div>
      </section>

      <section className="map-grid-section">
        <div className="library-heading">
          <div><span className="eyebrow">Map pool</span><strong>{visible.length} available</strong></div>
          <div className="search-box">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a map" />
          </div>
        </div>
        <div className="map-grid">
          {visible.map((map) => (
            <button key={map.name} className="map-tile" onClick={() => navigate(`/map/${encodeURIComponent(map.name)}`)}>
              <div className="map-orb">
                {map.preview_image_path ? <img src={assetUrl(map.preview_image_path)} alt="" /> : <span>{map.label.slice(0, 2)}</span>}
              </div>
              <div className="map-tile-footer">
                <span><strong>{map.label}</strong><small>{formatNumber(map.grenade_count)} lineups</small></span>
                <ArrowUpRight size={17} />
              </div>
            </button>
          ))}
        </div>
      </section>

      {importOpen ? (
        <div className={`library-import-layer ${activeImportId ? "overlay" : "required"}`}>
          {activeImportId ? <button className="library-import-close" type="button" onClick={closeImport} aria-label="Close import"><X size={18} /></button> : null}
          <ImportPage onImported={onImported} lastImport={lastImport} />
        </div>
      ) : null}
    </div>
  );
}
