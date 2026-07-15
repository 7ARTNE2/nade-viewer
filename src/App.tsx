import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Database,
  Download,
  FolderOpen,
  Map,
  Pencil,
  RotateCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  deleteImport,
  exportCoreNades,
  getActiveImport,
  listImports,
  setActiveImport,
  updateImportLabel,
} from "./lib/tauri";
import { compactDate, formatNumber } from "./lib/format";
import { startWindowActiveTracking } from "./lib/windowActive";
import type { ImportSummary } from "./types/domain";
import { version } from "../package.json";
import HomePage from "./pages/HomePage";
import MapPage from "./pages/MapPage";
import GrenadePage from "./pages/GrenadePage";
import Tooltip from "./components/Tooltip";

function importFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function snapshotDisplayName(snapshot: ImportSummary) {
  return snapshot.label?.trim() || importFileName(snapshot.source_path);
}

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeImport, setActive] = useState<ImportSummary | null>(null);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [coreTransferBusy, setCoreTransferBusy] = useState(false);
  const [coreTransferStatus, setCoreTransferStatus] = useState<string | null>(null);
  const [snapshotMenuOpen, setSnapshotMenuOpen] = useState(false);
  const [editingSnapshotId, setEditingSnapshotId] = useState<number | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [deleteSnapshotOpen, setDeleteSnapshotOpen] = useState(false);
  const importsRequestRef = useRef(0);
  const [operationError, setOperationError] = useState<string | null>(null);

  const refreshImports = useCallback(async () => {
    const requestId = ++importsRequestRef.current;
    try {
      const [active, all] = await Promise.all([getActiveImport(), listImports()]);
      if (importsRequestRef.current !== requestId) return;
      setActive(active);
      setImports(Array.isArray(all) ? all : []);
      if (!active && !["/", "/maps"].includes(location.pathname)) navigate("/maps?import=1", { replace: true });
    } finally {
      if (importsRequestRef.current === requestId) setLoading(false);
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    refreshImports().catch(() => setLoading(false));
  }, [refreshImports]);

  useEffect(() => startWindowActiveTracking(), []);

  const switchImport = async (id: number) => {
    setOperationError(null);
    try {
      const next = await setActiveImport(id);
      const all = await listImports();
      setActive(next);
      setImports(Array.isArray(all) ? all : []);
      setSnapshotMenuOpen(false);
      setEditingSnapshotId(null);
      navigate("/maps");
    } catch (error) {
      console.error(error);
      setOperationError("Could not switch library");
    }
  };

  const saveSnapshotLabel = async (snapshot: ImportSummary) => {
    const updated = await updateImportLabel(snapshot.id, editingLabel);
    setImports(await listImports());
    if (activeImport?.id === updated.id) setActive(updated);
    setEditingSnapshotId(null);
    setEditingLabel("");
  };

  const confirmDeleteSnapshot = async () => {
    if (!activeImport) return;
    setOperationError(null);
    try {
      const next = await deleteImport(activeImport.id);
      setDeleteSnapshotOpen(false);
      await refreshImports();
      navigate(next ? "/maps" : "/maps?import=1", { replace: true });
    } catch (error) {
      console.error(error);
      setOperationError("Could not delete library");
    }
  };

  const handleCoreExport = async () => {
    setCoreTransferBusy(true);
    setCoreTransferStatus(null);
    try {
      const report = await exportCoreNades();
      if (report) setCoreTransferStatus(`${formatNumber(report.grenade_count)} saved`);
    } catch (error) {
      console.error(error);
      setCoreTransferStatus("Export failed");
    } finally {
      setCoreTransferBusy(false);
    }
  };

  const mapsRouteActive = location.pathname === "/" || location.pathname === "/maps" || location.pathname.startsWith("/map/") || location.pathname.startsWith("/grenade/");
  const importPanelActive = location.pathname === "/maps" && new URLSearchParams(location.search).get("import") === "1";

  if (loading) {
    return (
      <div className="boot-screen viewer-boot">
        <div className="viewer-loader"><Sparkles size={20} /></div>
        <div className="boot-title">Nade Viewer <span className="boot-version">v{version}</span></div>
      </div>
    );
  }

  return (
    <div className="app-shell viewer-shell topnav-shell">
      <main className="app-main viewer-main">
        <header className="viewer-topbar">
          <div className="topbar-navigation">
            <button className="topbar-brand" onClick={() => navigate("/maps")} aria-label="Nade Viewer home">
              <span className="viewer-brand-mark">NV</span>
              <span className="topbar-brand-copy"><strong>Nade Viewer</strong><small>v{version}</small></span>
            </button>
            <span className="topbar-divider" />
            <button className={`topbar-nav-link ${mapsRouteActive && !importPanelActive ? "active" : ""}`} onClick={() => navigate("/maps")}>
              <Map size={16} /><span>Maps</span>
            </button>
            <button className={`topbar-nav-link ${importPanelActive ? "active" : ""}`} onClick={() => navigate("/maps?import=1")}>
              <Download size={16} /><span>Import library</span>
            </button>
          </div>
          <div className="topbar-actions">
            {activeImport ? (
              <div className="import-chip" data-tip={activeImport.source_path} data-tip-pos="bottom">
                <Database size={14} /><strong>{snapshotDisplayName(activeImport)}</strong><span>{formatNumber(activeImport.grenade_count)} nades</span>
              </div>
            ) : (
              <button className="btn primary" onClick={() => navigate("/maps?import=1")}><FolderOpen size={16} />Import data</button>
            )}
            {imports.length > 0 && activeImport ? (
              <div className="snapshot-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSnapshotMenuOpen(false); }}>
                <button className={`snapshot-trigger ${snapshotMenuOpen ? "active" : ""}`} onClick={() => setSnapshotMenuOpen((open) => !open)} aria-expanded={snapshotMenuOpen}>
                  <span>Library #{activeImport.id}</span><ChevronDown size={14} />
                </button>
                {snapshotMenuOpen ? (
                  <div className="snapshot-menu" role="listbox">
                    {imports.map((item) => {
                      const isEditing = editingSnapshotId === item.id;
                      return (
                        <div key={item.id} className={`snapshot-option ${item.id === activeImport.id ? "active" : ""} ${isEditing ? "editing" : ""}`}>
                          <span className="snapshot-id">#{item.id}</span>
                          {isEditing ? (
                            <form className="snapshot-edit-row" onSubmit={(event) => { event.preventDefault(); saveSnapshotLabel(item).catch(() => undefined); }}>
                              <input className="snapshot-edit-input" value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} placeholder={importFileName(item.source_path)} autoFocus />
                              <button className="snapshot-edit-action" type="submit"><Check size={14} /></button>
                              <button className="snapshot-edit-action" type="button" onClick={() => setEditingSnapshotId(null)}><X size={14} /></button>
                            </form>
                          ) : (
                            <>
                              <button className="snapshot-option-main" type="button" onClick={() => item.id === activeImport.id ? setSnapshotMenuOpen(false) : switchImport(item.id)}>
                                <span className="snapshot-main"><strong>{snapshotDisplayName(item)}</strong><small>{formatNumber(item.grenade_count)} grenades</small></span>
                                {item.id === activeImport.id ? <span className="snapshot-current">Active</span> : null}
                              </button>
                              <button className="snapshot-rename-btn" type="button" onClick={() => { setEditingSnapshotId(item.id); setEditingLabel(item.label?.trim() || ""); }}><Pencil size={13} /></button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            {activeImport ? <button className="icon-btn core-transfer" onClick={handleCoreExport} disabled={coreTransferBusy} data-tip="Export Core Nades"><Upload size={15} /></button> : null}
            {coreTransferStatus ? <span className="core-status-chip">{coreTransferStatus}</span> : null}
            {operationError ? <span className="operation-error-chip">{operationError}</span> : null}
            {activeImport ? <button className="icon-btn danger" onClick={() => setDeleteSnapshotOpen(true)} data-tip="Delete active library"><Trash2 size={15} /></button> : null}
            <button className="icon-btn" onClick={() => window.location.reload()} data-tip="Refresh"><RotateCw size={15} /></button>
          </div>
        </header>

        <div className="view-frame viewer-frame">
          <Routes>
            <Route path="/" element={<Navigate to={activeImport ? "/maps" : "/maps?import=1"} replace />} />
            <Route path="/maps" element={<HomePage activeImportId={activeImport?.id ?? null} onImported={refreshImports} lastImport={imports[0] ?? null} />} />
            <Route path="/import" element={<Navigate to="/maps?import=1" replace />} />
            <Route path="/map/:mapName" element={activeImport ? <MapPage activeImportId={activeImport.id} /> : <Navigate to="/maps?import=1" replace />} />
            <Route path="/grenade/:id" element={activeImport ? <GrenadePage /> : <Navigate to="/maps?import=1" replace />} />
            <Route path="*" element={<Navigate to={activeImport ? "/maps" : "/maps?import=1"} replace />} />
          </Routes>
        </div>
      </main>

      {deleteSnapshotOpen && activeImport ? (
        <div className="modal-scrim" role="presentation" onMouseDown={() => setDeleteSnapshotOpen(false)}>
          <div className="snapshot-delete-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="snapshot-delete-mark"><AlertTriangle size={19} /></div>
            <div className="snapshot-delete-copy"><div className="eyebrow">Delete library</div><h2>{snapshotDisplayName(activeImport)}</h2><p>Library #{activeImport.id} and {formatNumber(activeImport.grenade_count)} grenade rows will be removed.</p></div>
            <div className="snapshot-delete-meta"><span>Source</span><strong>{importFileName(activeImport.source_path)}</strong><span>Imported</span><strong>{compactDate(activeImport.imported_at)}</strong></div>
            <div className="snapshot-delete-actions"><button className="btn" onClick={() => setDeleteSnapshotOpen(false)}>Cancel</button><button className="btn danger-action" onClick={confirmDeleteSnapshot}><Trash2 size={15} />Delete</button></div>
          </div>
        </div>
      ) : null}
      <Tooltip />
    </div>
  );
}

export default function App() {
  return <Shell />;
}
