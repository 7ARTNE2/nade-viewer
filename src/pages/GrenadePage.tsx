import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BadgeCheck, Clipboard, Clock, Crosshair, FileText, MapPinned, Timer } from "lucide-react";
import MapCanvas from "../components/MapCanvas";
import GrenadeList from "../components/GrenadeList";
import ThrowKeyIcon from "../components/ThrowKeyIcon";
import { getGrenade, getSimilarGrenades, getSpawnPoints, recordGrenadeView, setGrenadeCore } from "../lib/tauri";
import { formatClock, formatNumber, grenadeLabel } from "../lib/format";
import { buildSpawnMapPoints, INSTA_LABEL, isInstaGrenade } from "../lib/insta";
import { splitThrowKeys, throwKeyVisual } from "../lib/throwKeys";
import type { GrenadeDetail, GrenadePreview, SpawnPoint } from "../types/domain";
import { useI18n } from "../i18n";

const detailTypeColor: Record<string, string> = {
  smoke: "#67e8f9",
  flash: "#fbbf24",
  molotov: "#fb7185",
  HE: "#34d399",
};

const detailTypeRgb: Record<string, string> = {
  smoke: "103, 232, 249",
  flash: "251, 191, 36",
  molotov: "251, 113, 133",
  HE: "52, 211, 153",
};

export default function GrenadePage() {
  const { tr } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const grenadeId = Number(id);
  const [grenade, setGrenade] = useState<GrenadeDetail | null>(null);
  const [similar, setSimilar] = useState<GrenadePreview[]>([]);
  const [spawnPoints, setSpawnPoints] = useState<SpawnPoint[]>([]);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isInteger(grenadeId) || grenadeId <= 0) {
      navigate("/maps", { replace: true });
      return;
    }
    let cancelled = false;
    setLoadError(null);
    getGrenade(grenadeId)
      .then(async (detail) => {
        if (cancelled) return;
        setGrenade({ ...detail, usage_throwers: Array.isArray(detail.usage_throwers) ? detail.usage_throwers : [] });
        recordGrenadeView(detail.id).catch(() => undefined);
        const [list, spawns] = await Promise.all([getSimilarGrenades(grenadeId, 10), getSpawnPoints(detail.map, "Any")]);
        if (cancelled) return;
        setSimilar(Array.isArray(list) ? list : []);
        setSpawnPoints(Array.isArray(spawns) ? spawns : []);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setLoadError("This grenade is no longer available in the active library.");
      });
    return () => {
      cancelled = true;
    };
  }, [grenadeId, navigate]);

  const previewPoint = useMemo(() => (grenade ? [{ ...grenade }] : []), [grenade]);
  const spawnMapPoints = useMemo(() => buildSpawnMapPoints(spawnPoints), [spawnPoints]);
  const isInsta = grenade ? isInstaGrenade(grenade, spawnMapPoints) : false;
  const throwKeys = splitThrowKeys(grenade?.throw_description);
  const detailAccent = grenade ? detailTypeColor[grenade.grenade_type] ?? "#e5e7eb" : "#e5e7eb";
  const detailAccentRgb = grenade ? detailTypeRgb[grenade.grenade_type] ?? "229, 231, 235" : "229, 231, 235";

  const copy = async (text?: string | null) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  };

  const goBack = () => {
    if (!grenade) return;
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === "number" && historyState.idx > 0) {
      navigate(-1);
      return;
    }
    navigate(`/map/${encodeURIComponent(grenade.map)}`, { replace: true });
  };

  const handleCoreToggle = async (id: number, isCore: boolean) => {
    await setGrenadeCore(id, isCore);
    setSimilar((list) => list.map((item) => (item.id === id ? { ...item, is_core: isCore } : item)));
    setGrenade((current) => (current && current.id === id ? { ...current, is_core: isCore } : current));
  };

  if (!grenade) {
    if (loadError) return <div className="detail-load-error"><strong>{tr("Unable to open grenade", "Не удалось открыть гранату")}</strong><p>{loadError}</p><button className="btn primary" onClick={() => navigate("/maps")}>{tr("Back to maps", "К картам")}</button></div>;
    return (
      <div className="detail-loading">
        <div className="loader-ring" />
      </div>
    );
  }

  return (
    <div className="grenade-detail">
      <section className="detail-map-panel">
        <div className="map-toolbar">
          <button className="icon-btn" onClick={goBack}>
            <ArrowLeft size={16} />
          </button>
          <div className="map-heading">
            <strong>{tr("Grenade", "Граната")} #{grenade.id}</strong>
            <span>{grenade.map} / {grenadeLabel(grenade.grenade_type)}</span>
          </div>
        </div>
        <MapCanvas mapImagePath={grenade.map_image_path} grenades={previewPoint} spawnPoints={spawnPoints} />
      </section>

      <aside className="detail-inspector" style={{ "--dot": detailAccent, "--detail-rgb": detailAccentRgb } as React.CSSProperties}>
        <div className="detail-title-row">
          <span className={`type-pill ${String(grenade.grenade_type).toLowerCase()}`}>{grenadeLabel(grenade.grenade_type)}</span>
          <span className="side-mini">{grenade.side}</span>
          <strong>{grenade.thrower || tr("Parsed grenade", "Распознанная граната")}</strong>
          {isInsta ? <span className="insta-badge">{INSTA_LABEL}</span> : null}
          <button className={`core-action detail-core ${grenade.is_core ? "active" : ""}`} onClick={() => handleCoreToggle(grenade.id, !grenade.is_core)}>
            <BadgeCheck size={14} />
            {grenade.is_core ? tr("In Core", "В Core") : tr("Add to Core", "Добавить в Core")}
          </button>
        </div>

        <div className="metric-grid">
          <div><Timer size={14} /><span>{tr("Airtime", "Время полета")}</span><strong>{typeof grenade.airtime === "number" ? `${grenade.airtime.toFixed(2)}s` : "-"}</strong></div>
          <div><Clock size={14} /><span>{tr("Round", "Раунд")}</span><strong>{formatClock(grenade.round_time_seconds)}</strong></div>
          <div><Crosshair size={14} /><span>{tr("Usage", "Использования")}</span><strong>{formatNumber(grenade.usage_count)}</strong></div>
          <div><MapPinned size={14} /><span>Tickrate</span><strong>{grenade.tickrate ?? "-"}</strong></div>
        </div>

        <div className="info-block">
          <div className="block-title">{tr("Throw keys", "Клавиши броска")}</div>
          {throwKeys.length ? (
            <div className="throw-preview-keys detail-throw-keys">
              {throwKeys.map((key, index) => {
                const visual = throwKeyVisual(key);
                return (
                  <span className="throw-preview-key-part" key={`${key}-${index}`}>
                    <span className={`throw-preview-key-icon ${visual.kind}`} data-tip={visual.title}>
                      <ThrowKeyIcon glyph={visual.glyph} />
                      <span>{visual.label}</span>
                    </span>
                    {index < throwKeys.length - 1 ? <span className="throw-preview-plus">+</span> : null}
                  </span>
                );
              })}
            </div>
          ) : (
            <code>-</code>
          )}
        </div>

        <div className="info-block">
          <div className="block-title">
            {tr("Coordinates", "Координаты")}
            <button className="micro-btn" onClick={() => copy(grenade.coordinates)}>
              <Clipboard size={13} />
              {copied ? tr("Copied", "Скопировано") : tr("Copy", "Копировать")}
            </button>
          </div>
          <code>{grenade.coordinates || "-"}</code>
        </div>

        <div className="info-block">
          <div className="block-title">{tr("Demo metadata", "Данные демо")}</div>
          <div className="kv-list">
            <span>{tr("Throw tick", "Тик броска")}</span><strong>{grenade.throw_tick ?? "-"}</strong>
            <span>{tr("Lineup tick", "Тик подготовки")}</span><strong>{grenade.lineup_tick ?? "-"}</strong>
            <span>{tr("Demo", "Демо")}</span><strong className="demo-filename"><FileText size={12} />{grenade.demo_filename || "-"}</strong>
          </div>
        </div>

        <div className="info-block usage-throwers-block">
          <div className="block-title">
            {tr("Usage throwers", "Использовали игроки")}
            {grenade.usage_throwers.length ? <span className="block-count">{grenade.usage_throwers.length}</span> : null}
          </div>
          {grenade.usage_throwers.length ? (
            <div className="thrower-list">
              {grenade.usage_throwers.map((thrower, index) => (
                <span key={`${thrower}-${index}`} data-tip={thrower}>
                  {thrower}
                </span>
              ))}
            </div>
          ) : (
            <div className="empty-inline">-</div>
          )}
        </div>

        <div className="info-block">
          <div className="block-title">{tr("Similar grenades", "Похожие гранаты")}</div>
          <GrenadeList grenades={similar} compact showCopy spawnPoints={spawnPoints} onCoreToggle={handleCoreToggle} emptyLabel={tr("No similar grenades.", "Похожих гранат нет.")} />
        </div>
      </aside>
    </div>
  );
}
