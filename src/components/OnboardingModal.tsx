import { ArrowRight, Check, Database } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

type OnboardingModalProps = {
  onComplete: () => Promise<void>;
  onStart: () => void;
  activeImport: boolean;
  pathname: string;
};

type TourStep = { selector: string; eyebrow: string; title: string; copy: string };

const steps: TourStep[] = [
  { selector: '[data-tour="import-choose-file"]', eyebrow: "Step 1: import", title: "Choose your grenade library", copy: "Select grenade_index.json or a Core Nades JSON file. The import stays local on this device." },
  { selector: '[data-tour="map-tile"]', eyebrow: "Step 2: maps", title: "Open a map", copy: "Each tile opens the lineups available for that map. Choose any map to continue." },
  { selector: '[data-tour="map-filters"]', eyebrow: "Step 3: filters", title: "Narrow down lineups", copy: "Filter by grenade type and side, or search for a thrower, demo, or console command." },
  { selector: '[data-tour="map-canvas"]', eyebrow: "Step 4: tactical map", title: "Read the map", copy: "Scroll to zoom and drag to pan. The Map legend explains marker colors, trajectories, and spawn points." },
  { selector: '[data-tour="cluster-list"]', eyebrow: "Step 5: lineups", title: "Select a cluster", copy: "Choose a landing or throw cluster to load its individual grenades. Open any grenade from the list for full details." },
];

export default function OnboardingModal({ onComplete, onStart, activeImport, pathname }: OnboardingModalProps) {
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const target = started ? steps[step] : null;

  useEffect(() => {
    if (!started) return;
    if (activeImport && pathname === "/maps") setStep(1);
    if (pathname.startsWith("/map/")) setStep((value) => Math.max(value, 2));
  }, [activeImport, pathname, started]);

  useLayoutEffect(() => {
    if (!target) return;
    const update = () => setRect(document.querySelector(target.selector)?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); observer.disconnect(); };
  }, [target]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      console.error(cause);
      setError("Could not save tutorial progress. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`onboarding-layer ${started ? "tour-active" : ""}`}>
      {rect ? <div className="onboarding-highlight" style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} /> : null}
      <section className="onboarding-dialog" role="dialog" aria-modal={!started} aria-labelledby="onboarding-title" style={started && rect ? { left: Math.min(Math.max(16, rect.left), window.innerWidth - 420), top: Math.min(rect.bottom + 14, window.innerHeight - 250) } : undefined}>
        {!started ? <div className="onboarding-icon"><Database size={23} /></div> : null}
        <div className="eyebrow">{started ? target?.eyebrow : "Your local playbook"}</div>
        <h1 id="onboarding-title">{started ? target?.title : "Welcome to Nade Viewer"}</h1>
        <p>{started ? target?.copy : "This short guided tour points to the controls as you use them, so you can learn the viewer with your own grenade library."}</p>
        {error ? <div className="onboarding-error">{error}</div> : null}
        <div className="onboarding-actions">
          <button className="onboarding-skip" type="button" disabled={busy} onClick={() => run(onComplete)}>Skip tutorial</button>
          <div className="onboarding-actions-right">
            {!started ? (
              <button className="btn primary" type="button" autoFocus disabled={busy} onClick={() => { setStarted(true); onStart(); }}>Start tour<ArrowRight size={15} /></button>
            ) : step < steps.length - 1 ? (
              <button className="btn primary" type="button" disabled={busy} onClick={() => setStep((value) => value + 1)}>Next tip<ArrowRight size={15} /></button>
            ) : (
              <button className="btn primary" type="button" disabled={busy} onClick={() => run(onComplete)}>Finish<Check size={15} /></button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
