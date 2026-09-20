import {
  ArrowRight,
  Check,
  CircleHelp,
  ClipboardCheck,
  Database,
  Layers3,
  Map,
  ScanLine,
  SlidersHorizontal,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';

type OnboardingModalProps = {
  onComplete: () => Promise<void>;
  onShowImport: () => void;
  onShowMaps: () => void;
  activeImport: boolean;
  pathname: string;
};

type TourStep = {
  selector: string;
  icon: LucideIcon;
  title: string;
  copy: string;
};

const steps: TourStep[] = [
  {
    selector: '[data-tour="import-choose-file"]',
    icon: Upload,
    title: 'Bring in your playbook',
    copy: 'Load a grenade_index.json or Core Nades file. Everything stays local to this device.',
  },
  {
    selector: '[data-tour="map-target"]',
    icon: Map,
    title: 'Pick a map to explore',
    copy: 'Choose a map and move from the library into the tactical workspace.',
  },
  {
    selector: '[data-tour="map-workspace-toolbar"]',
    icon: ScanLine,
    title: 'Shape the view around the task',
    copy: 'Switch maps, focus the radar, change marker styles, or narrow the view to Core and instant throws.',
  },
  {
    selector: '[data-tour="map-filters"]',
    icon: SlidersHorizontal,
    title: 'Cut through the noise',
    copy: 'Combine filters for type, side, tournament, team, player, or search. Reset to see the full library again.',
  },
  {
    selector: '[data-tour="map-canvas"]',
    icon: ScanLine,
    title: 'Read the radar at a glance',
    copy: 'Scroll to zoom, drag to pan, then select a marker or cluster to reveal the throws behind it.',
  },
  {
    selector: '[data-tour="map-legend"]',
    icon: CircleHelp,
    title: 'Make every mark count',
    copy: 'Use the legend to decode sides, grenade types, spawns, and trajectory lines. Reset the zoom when needed.',
  },
  {
    selector: '[data-tour="cluster-list"]',
    icon: Layers3,
    title: 'Start with a cluster',
    copy: 'Nearby landing or throw positions are grouped together. Select one here or directly on the radar.',
  },
  {
    selector: '[data-tour="grenade-list"]',
    icon: ClipboardCheck,
    title: 'Turn a find into a setup',
    copy: 'Open a lineup for its thrower, landing point, and command. Copy it for practice or save it to Core.',
  },
];

const russianTitles = [
  'Загрузите свой плейбук',
  'Выберите карту для изучения',
  'Настройте рабочий вид',
  'Отсейте лишнее',
  'Читайте радар с первого взгляда',
  'Разберитесь в обозначениях',
  'Начните с кластера',
  'Превратите находку в готовый сетап',
];

const russianCopies = [
  'Загрузите grenade_index.json или файл Core Nades. Все данные останутся на этом устройстве.',
  'Выберите карту и перейдите из библиотеки в тактическое рабочее пространство.',
  'Меняйте карту, фокусируйтесь на радаре, переключайте маркеры или оставляйте только Core и инста-броски.',
  'Комбинируйте фильтры типа, стороны, турнира, команды, игрока и поиска. Сбросьте их, чтобы увидеть всю библиотеку.',
  'Приближайте колесом, перемещайте карту перетаскиванием, затем выберите маркер или кластер.',
  'Легенда объясняет стороны, типы гранат, точки спавна и траектории. При необходимости сбросьте масштаб.',
  'Близкие позиции приземления или броска объединены в группы. Выберите кластер здесь или прямо на радаре.',
  'Откройте раскидку, чтобы увидеть игрока, точку приземления и команду. Скопируйте ее для тренировки или добавьте в Core.',
];

export default function OnboardingModal({
  onComplete,
  onShowImport,
  onShowMaps,
  activeImport,
  pathname,
}: OnboardingModalProps) {
  const { locale, tr } = useI18n();
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dialogPosition, setDialogPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [mapTargetAvailable, setMapTargetAvailable] = useState(false);
  const [mapSelectionPending, setMapSelectionPending] = useState(false);
  const target = started ? steps[step] : null;
  const StepIcon = target?.icon;
  const close = useCallback(() => {
    if (!busy) void onComplete();
  }, [busy, onComplete]);
  const dialogRef = useModalAccessibility(true, close);

  useEffect(() => {
    if (!started) return;
    if (activeImport && pathname === '/maps')
      setStep((value) => Math.max(value, 1));
    if (pathname.startsWith('/map/')) {
      setMapSelectionPending(false);
      setStep((value) => Math.max(value, 2));
    }
  }, [activeImport, pathname, started]);

  useEffect(() => {
    if (!started || step !== 1) return;
    const advanceAfterMapSelection = (event: MouseEvent) => {
      if (
        (event.target as Element | null)?.closest('[data-tour="map-target"]')
      ) {
        setMapSelectionPending(true);
      }
    };
    window.addEventListener('click', advanceAfterMapSelection, true);
    return () =>
      window.removeEventListener('click', advanceAfterMapSelection, true);
  }, [started, step]);

  useEffect(() => {
    if (!started || step !== 6) return;
    const advanceAfterClusterSelection = (event: MouseEvent) => {
      if (
        (event.target as Element | null)?.closest('[data-tour="cluster-list"]')
      ) {
        setStep(7);
      }
    };
    window.addEventListener('click', advanceAfterClusterSelection, true);
    return () =>
      window.removeEventListener('click', advanceAfterClusterSelection, true);
  }, [started, step]);

  useLayoutEffect(() => {
    if (!target) return;
    const update = () => {
      const element = document.querySelector(target.selector);
      const nextRect = element?.getBoundingClientRect() ?? null;
      setRect(nextRect);
      if (step === 1) setMapTargetAvailable(Boolean(element));
      if (!nextRect || !dialogRef.current) {
        setDialogPosition(null);
        return;
      }

      const dialog = dialogRef.current.getBoundingClientRect();
      const margin = 16;
      const gap = 14;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const fitsBelow =
        nextRect.bottom + gap + dialog.height <= viewportHeight - margin;
      const fitsAbove = nextRect.top - gap - dialog.height >= margin;
      const fitsRight =
        nextRect.right + gap + dialog.width <= viewportWidth - margin;
      const fitsLeft = nextRect.left - gap - dialog.width >= margin;
      const preferSidePlacement =
        step === 5 &&
        element instanceof HTMLElement &&
        element.hasAttribute('open');
      let top = fitsBelow
        ? nextRect.bottom + gap
        : fitsAbove
          ? nextRect.top - dialog.height - gap
          : Math.max(margin, (viewportHeight - dialog.height) / 2);
      let left = Math.min(
        Math.max(margin, nextRect.left),
        Math.max(margin, viewportWidth - dialog.width - margin),
      );
      if (preferSidePlacement && fitsRight) {
        left = nextRect.right + gap;
        top = nextRect.top;
      } else if (preferSidePlacement && fitsLeft) {
        left = nextRect.left - dialog.width - gap;
        top = nextRect.top;
      } else if (!fitsBelow && !fitsAbove && fitsRight)
        left = nextRect.right + gap;
      else if (!fitsBelow && !fitsAbove && fitsLeft)
        left = nextRect.left - dialog.width - gap;
      if (
        !preferSidePlacement &&
        !fitsBelow &&
        !fitsAbove &&
        (fitsRight || fitsLeft)
      ) {
        top = nextRect.bottom - dialog.height;
      }
      top = Math.min(
        Math.max(margin, top),
        Math.max(margin, viewportHeight - dialog.height - margin),
      );
      setDialogPosition({ left, top });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new MutationObserver(update);
    const element = document.querySelector(target.selector);
    observer.observe(document.body, { childList: true, subtree: true });
    if (element) observer.observe(element, { attributes: true });
    const resizeObserver = element ? new ResizeObserver(update) : null;
    if (element) resizeObserver?.observe(element);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer.disconnect();
      resizeObserver?.disconnect();
    };
  }, [dialogRef, step, target]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      console.error(cause);
      setError(
        tr(
          'Could not save tutorial progress. Please try again.',
          'Не удалось сохранить прогресс обучения. Попробуйте еще раз.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`onboarding-layer ${started ? 'tour-active' : ''}`}>
      {rect ? (
        <div
          className="onboarding-highlight"
          style={{
            left: rect.left - 5,
            top: rect.top - 5,
            width: rect.width + 10,
            height: rect.height + 10,
          }}
        />
      ) : null}
      <section
        ref={dialogRef}
        className="onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        style={
          started && dialogPosition
            ? {
                left: dialogPosition.left,
                top: dialogPosition.top,
              }
            : undefined
        }
      >
        {started ? (
          <div className="onboarding-stepbar">
            <span className="onboarding-stage">
              {tr('TUTORIAL', 'ТУТОРИАЛ')}
            </span>
            <div className="onboarding-progress-track" aria-hidden="true">
              {steps.map((tourStep, index) => (
                <i
                  className={index <= step ? 'active' : ''}
                  key={tourStep.selector}
                />
              ))}
            </div>
            <span className="onboarding-progress" aria-live="polite">
              {tr(
                `${step + 1} / ${steps.length}`,
                `${step + 1} / ${steps.length}`,
              )}
            </span>
          </div>
        ) : null}
        {started && StepIcon ? (
          <div className="onboarding-step-icon" aria-hidden="true">
            <StepIcon size={22} strokeWidth={1.8} />
          </div>
        ) : (
          <div className="onboarding-icon">
            <Database size={23} />
          </div>
        )}
        <h1 id="onboarding-title">
          {started && locale === 'ru'
            ? russianTitles[step]
            : started
              ? target?.title
              : tr('Welcome to Nade Viewer', 'Добро пожаловать в Nade Viewer')}
        </h1>
        <p>
          {started && step === 1 && !mapTargetAvailable
            ? tr(
                'This library has no maps to show yet. Import a non-empty grenade library to continue the tour, or skip it.',
                'В этой библиотеке пока нет карт. Импортируйте непустую библиотеку гранат, чтобы продолжить обучение, или пропустите его.',
              )
            : started && locale === 'ru'
              ? russianCopies[step]
              : started
                ? target?.copy
                : activeImport
                  ? tr(
                      'A grenade library is already loaded. The tour will start with the map selection screen and use the first available map.',
                      'Библиотека уже загружена. Обучение начнется с выбора первой доступной карты.',
                    )
                  : tr(
                      'Start by importing a library. Then the tour will show map selection and a workspace for the first available map.',
                      'Сначала импортируйте библиотеку. Затем обучение покажет выбор карты и интерфейс первой доступной карты.',
                    )}
        </p>
        {error ? <div className="onboarding-error">{error}</div> : null}
        <div className="onboarding-actions">
          <button
            className="onboarding-skip"
            type="button"
            disabled={busy}
            onClick={() => run(onComplete)}
          >
            {tr('Skip tutorial', 'Пропустить')}
          </button>
          <div className="onboarding-actions-right">
            {!started ? (
              <button
                className="btn primary"
                type="button"
                autoFocus
                disabled={busy}
                onClick={() => {
                  setStarted(true);
                  if (activeImport) {
                    setStep(1);
                    onShowMaps();
                  } else {
                    onShowImport();
                  }
                }}
              >
                {tr('Start tour', 'Начать обучение')}
                <ArrowRight size={15} />
              </button>
            ) : step === 0 ? (
              <button
                className="btn primary"
                type="button"
                disabled={busy || !activeImport}
                onClick={() => {
                  setStep(1);
                  onShowMaps();
                }}
              >
                {tr('Choose a map', 'Выбрать карту')}
                <ArrowRight size={15} />
              </button>
            ) : step === 1 ? (
              mapTargetAvailable ? (
                <span className="onboarding-next-hint">
                  {mapSelectionPending
                    ? tr('Opening map...', 'Открываем карту...')
                    : tr(
                        'Click the highlighted map to continue',
                        'Нажмите на выделенную карту, чтобы продолжить',
                      )}
                </span>
              ) : (
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      onShowImport();
                    })
                  }
                >
                  {tr('Import a library', 'Импортировать библиотеку')}
                </button>
              )
            ) : step < steps.length - 1 ? (
              <button
                className="btn primary"
                type="button"
                disabled={busy}
                onClick={() => setStep((value) => value + 1)}
              >
                {tr('Next tip', 'Далее')}
                <ArrowRight size={15} />
              </button>
            ) : (
              <button
                className="btn primary"
                type="button"
                disabled={busy}
                onClick={() => run(onComplete)}
              >
                {tr('Finish', 'Завершить')}
                <Check size={15} />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
