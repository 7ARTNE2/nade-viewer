import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Database, FileJson, FolderOpen, History, ShieldCheck, Upload } from "lucide-react";
import { getImportStatus, importJson, selectImportFile } from "../lib/tauri";
import { compactDate, formatNumber } from "../lib/format";
import type { ImportStatus, ImportSummary } from "../types/domain";

type Props = {
  onImported: () => Promise<void>;
  lastImport: ImportSummary | null;
};

export default function ImportPage({ onImported, lastImport }: Props) {
  const navigate = useNavigate();
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<ImportStatus>({ running: false, stage: "idle", current: 0, total: 0, message: "Ready" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const progress = useMemo(() => (status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : busy ? 8 : 0), [busy, status]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      getImportStatus().then(setStatus).catch(() => undefined);
    }, 350);
    return () => window.clearInterval(timer);
  }, [busy]);

  const choose = async () => {
    try {
      const selected = await selectImportFile();
      if (selected) setPath(selected);
    } catch (error) {
      console.error(error);
      setMessage("Unable to open the file picker");
    }
  };

  const runImport = async (nextPath = path) => {
    if (!nextPath.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const report = await importJson(nextPath.trim());
      setStatus(await getImportStatus());
      await onImported();
      if (report.kind === "core_nades") {
        setMessage(`Imported ${formatNumber(report.grenade_count)} Core Nades snapshot`);
      }
      navigate("/maps", { replace: true });
    } catch (error) {
      setMessage(typeof error === "string" ? error : error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0] as File & { path?: string };
    if (file?.path) {
      setPath(file.path);
      runImport(file.path).catch(() => undefined);
    }
  };

  return (
    <div className="import-view" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <section className="import-panel">
        <div className="import-copy">
          <div className="import-orbit"><FileJson size={32} /></div>
          <div className="eyebrow">Library setup</div>
          <h1>Bring your<br />lineups in.</h1>
          <p className="muted wide">Load a grenade index or a curated Core Nades collection. Everything stays on this device.</p>
          <div className="import-features">
            <span><ShieldCheck size={16} /> Local SQLite storage</span>
            <span><CheckCircle2 size={16} /> Format detected automatically</span>
          </div>
        </div>

        <div className="import-action-card">
          <div className={`drop-zone ${busy ? "working" : ""}`}>
            <Database size={24} />
            <strong>{busy ? status.message : message ?? "Drop JSON file here"}</strong>
            <span>{busy ? `${progress}% complete` : "grenade_index.json or Core Nades JSON"}</span>
          </div>

          {busy ? <div className="progress-shell"><div className="progress-bar" style={{ width: `${Math.max(progress, 6)}%` }} /></div> : null}

          <div className="file-picker-row">
            <button className="btn primary" data-tour="import-choose-file" onClick={choose} disabled={busy}><FolderOpen size={17} />Choose file</button>
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="Path to JSON file" disabled={busy} />
            <button className="btn" onClick={() => runImport()} disabled={busy || !path.trim()}><Upload size={17} />Import</button>
          </div>

          {lastImport ? (
            <button className="last-import" onClick={() => setPath(lastImport.source_path)} disabled={busy}>
              <History size={15} /><span>Use recent source</span><strong>{formatNumber(lastImport.grenade_count)} lineups</strong><small>{compactDate(lastImport.imported_at)}</small>
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
