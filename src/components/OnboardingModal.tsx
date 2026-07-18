import { ArrowRight, Check, Database } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useModalAccessibility } from "../lib/useModalAccessibility";

type OnboardingModalProps = {
  onComplete: () => Promise<void>;
  onShowImport: () => void;
  onShowMaps: () => void;
  activeImport: boolean;
  pathname: string;
};

type TourStep = { selector: string; eyebrow: string; title: string; copy: string };

const steps: TourStep[] = [
  { selector: '[data-tour="import-choose-file"]', eyebrow: "Step 1: import", title: "Choose your grenade library", copy: "Select grenade_index.json or a Core Nades JSON file. The import stays local on this device." },
  { selector: '[data-tour="map-target"]', eyebrow: "Step 2: map", title: "Open a map", copy: "Select the first available map to continue. The walkthrough works with any map in your library." },
  { selector: '[data-tour="map-filters"]', eyebrow: "Step 3: filters", title: "Narrow down lineups", copy: "Filter by grenade type and side, or search for a thrower, demo, or console command." },
  { selector: '[data-tour="map-canvas"]', eyebrow: "Step 4: tactical map", title: "Read the map", copy: "Scroll to zoom and drag to pan. The Map legend explains marker colors, trajectories, and spawn points." },
  { selector: '[data-tour="cluster-list"]', eyebrow: "Step 5: lineups", title: "Select a cluster", copy: "Choose a landing or throw cluster to load its individual grenades. Open any grenade from the list for full details." },
];

export default function OnboardingModal({ onComplete, onShowImport, onShowMaps, activeImport, pathname }: OnboardingModalProps) {
  const { locale, tr } = useI18n();
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [mapTargetAvailable, setMapTargetAvailable] = useState(false);
  const target = started ? steps[step] : null;
  const close = useCallback(() => { if (!busy) void onComplete(); }, [busy, onComplete]);
  const dialogRef = useModalAccessibility(true, close);

  useEffect(() => {
    if (!started) return;
    if (activeImport && pathname === "/maps") setStep(1);
    if (pathname.startsWith("/map/")) setStep((value) => Math.max(value, 2));
  }, [activeImport, pathname, started]);

  useLayoutEffect(() => {
    if (!target) return;
    const update = () => {
      const element = document.querySelector(target.selector);
      setRect(element?.getBoundingClientRect() ?? null);
      if (step === 1) setMapTargetAvailable(Boolean(element));
    };
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
      <section ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" style={started && rect ? { left: Math.min(Math.max(16, rect.left), window.innerWidth - 420), top: Math.min(rect.bottom + 14, window.innerHeight - 250) } : undefined}>
        {!started ? <div className="onboarding-icon"><Database size={23} /></div> : null}
         <div className="eyebrow">{started && locale === "ru" ? ["Шаг 1: импорт", "Шаг 2: карта", "Шаг 3: фильтры", "Шаг 4: тактическая карта", "Шаг 5: раскидки"][step] : started ? target?.eyebrow : tr("Your local playbook", "Ваш локальный плейбук")}</div>
         <h1 id="onboarding-title">{started && locale === "ru" ? ["Выберите библиотеку гранат", "Откройте карту", "Настройте фильтры", "Изучите карту", "Выберите кластер"][step] : started ? target?.title : tr("Welcome to Nade Viewer", "Добро пожаловать в Nade Viewer")}</h1>
         <p>{started && step === 1 && !mapTargetAvailable ? tr("This library has no maps to show yet. Import a non-empty grenade library to continue the tour, or skip it.", "В этой библиотеке пока нет карт. Импортируйте непустую библиотеку гранат, чтобы продолжить обучение, или пропустите его.") : started && locale === "ru" ? ["Выберите grenade_index.json или JSON Core Nades. Данные останутся на устройстве.", "Выберите первую доступную карту, чтобы продолжить обучение.", "Фильтруйте по типу гранаты и стороне или ищите игрока, демо и команду.", "Колесо меняет масштаб, перетаскивание двигает карту. Легенда объясняет маркеры и траектории.", "Выберите кластер броска или приземления, затем откройте гранату для подробностей."][step] : started ? target?.copy : activeImport ? tr("A grenade library is already loaded. The tour will start with the map selection screen and use the first available map.", "Библиотека уже загружена. Обучение начнется с выбора первой доступной карты.") : tr("Start by importing a library. Then the tour will show map selection and a workspace for the first available map.", "Сначала импортируйте библиотеку. Затем обучение покажет выбор карты и интерфейс первой доступной карты.")}</p>
        {error ? <div className="onboarding-error">{error}</div> : null}
        <div className="onboarding-actions">
          <button className="onboarding-skip" type="button" disabled={busy} onClick={() => run(onComplete)}>{tr("Skip tutorial", "Пропустить")}</button>
          <div className="onboarding-actions-right">
            {!started ? (
              <button className="btn primary" type="button" autoFocus disabled={busy} onClick={() => { setStarted(true); if (activeImport) { setStep(1); onShowMaps(); } else { onShowImport(); } }}>{tr("Start tour", "Начать обучение")}<ArrowRight size={15} /></button>
             ) : step === 0 ? (
               <button className="btn primary" type="button" disabled={busy || !activeImport} onClick={() => { setStep(1); onShowMaps(); }}>{tr("Choose a map", "Выбрать карту")}<ArrowRight size={15} /></button>
             ) : step === 1 ? (
               <button className="btn primary" type="button" disabled={busy || mapTargetAvailable} onClick={() => run(async () => { onShowImport(); })}>{mapTargetAvailable ? tr("Open the highlighted map", "Откройте выделенную карту") : tr("Import a library", "Импортировать библиотеку")}</button>
            ) : step < steps.length - 1 ? (
              <button className="btn primary" type="button" disabled={busy} onClick={() => setStep((value) => value + 1)}>{tr("Next tip", "Далее")}<ArrowRight size={15} /></button>
            ) : (
              <button className="btn primary" type="button" disabled={busy} onClick={() => run(onComplete)}>{tr("Finish", "Завершить")}<Check size={15} /></button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
