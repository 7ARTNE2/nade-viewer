import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, BadgeCheck, Check, Clipboard, Timer } from "lucide-react";
import { grenadeLabel } from "../lib/format";
import { buildSpawnMapPoints, INSTA_LABEL, isInstaGrenade } from "../lib/insta";
import type { GrenadePreview, SpawnPoint } from "../types/domain";

type Props = {
  grenades: GrenadePreview[];
  compact?: boolean;
  showCopy?: boolean;
  spawnPoints?: SpawnPoint[];
  onCoreToggle?: (id: number, isCore: boolean) => void;
  emptyLabel?: string;
};

export default function GrenadeList({ grenades, compact, showCopy, spawnPoints = [], onCoreToggle, emptyLabel = "Select a landing cluster to load grenades." }: Props) {
  const navigate = useNavigate();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const spawnMapPoints = useMemo(() => buildSpawnMapPoints(spawnPoints), [spawnPoints]);

  const copyGrenadeText = async (grenade: GrenadePreview) => {
    const text = grenade.coordinates || grenade.throw_description;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedId(grenade.id);
    window.setTimeout(() => setCopiedId(null), 900);
  };

  if (!grenades.length) {
    return <div className="empty-note">{emptyLabel}</div>;
  }

  return (
    <div className={compact ? "nade-list compact" : "nade-list"}>
      {grenades.map((g) => {
        const isInsta = isInstaGrenade(g, spawnMapPoints);
        return (
          <div
            key={g.id}
            className={`nade-row type-${String(g.grenade_type).toLowerCase()} ${g.is_core ? "core" : ""} ${isInsta ? "insta" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/grenade/${g.id}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigate(`/grenade/${g.id}`);
              }
            }}
          >
            <span className="nade-type-stack">
              <span className={`type-pill ${String(g.grenade_type).toLowerCase()}`}>{grenadeLabel(g.grenade_type)}</span>
              {showCopy ? (
                <button
                  type="button"
                  className="copy-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    copyGrenadeText(g);
                  }}
                  disabled={!g.coordinates && !g.throw_description}
                  aria-label="Copy grenade coordinates"
                  data-tip={copiedId === g.id ? "Copied" : "Copy coordinates"}
                >
                  {copiedId === g.id ? <Check size={13} /> : <Clipboard size={13} />}
                  <span>{copiedId === g.id ? "Copied" : "Copy"}</span>
                </button>
              ) : null}
            </span>
            <span className="side-mini">{g.side}</span>
            <span className="nade-main">
              <span className="nade-title-line">
                <strong>{g.thrower || `Grenade #${g.id}`}</strong>
                {isInsta ? <span className="insta-badge">{INSTA_LABEL}</span> : null}
                {g.is_core ? <span className="core-badge">Core</span> : null}
              </span>
              <small>{g.throw_description || g.coordinates || "No command metadata"}</small>
            </span>
            <span className="nade-action-stack">
              <button
                type="button"
                className={`core-action ${g.is_core ? "active" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCoreToggle?.(g.id, !g.is_core);
                }}
                aria-label={g.is_core ? "Remove from Core" : "Add to Core"}
                data-tip={g.is_core ? "In Core" : "Add to Core"}
              >
                <BadgeCheck size={14} />
                <span>{g.is_core ? "In Core" : "Add to Core"}</span>
              </button>
              <span className="row-meta">
                {typeof g.airtime === "number" ? (
                  <>
                    <Timer size={12} />
                    {g.airtime.toFixed(2)}s
                  </>
                ) : (
                  `${g.usage_count}x`
                )}
              </span>
            </span>
            <ArrowRight size={14} />
          </div>
        );
      })}
    </div>
  );
}
