import {
  ArrowRight,
  Check,
  CircleHelp,
  ClipboardCheck,
  Database,
  Eye,
  Layers3,
  Map,
  ScanLine,
  SlidersHorizontal,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';

type OnboardingModalProps = {
  onComplete: () => Promise<void>;
  onShowImport: () => void;
  onShowMaps: () => void;
  activeImport: boolean;
  importState: 'idle' | 'importing' | 'complete';
  pathname: string;
};

type TourStep = {
  selector: string;
  dialogAnchor?: string | (() => Element | null);
  icon: LucideIcon;
  title: string;
  copy: string;
};

function resolveAnchor(
  element: Element | null,
  dialogAnchor: TourStep['dialogAnchor'],
) {
  if (typeof dialogAnchor === 'function') return dialogAnchor();
  if (typeof dialogAnchor === 'string')
    return document.querySelector(dialogAnchor);
  return element;
}

const steps: TourStep[] = [
  {
    selector: '[data-tour="import-choose-file"]',
    dialogAnchor: '.import-action-card',
    icon: Upload,
    title: 'Import a lineup library',
    copy: 'Load a grenade_index.json or Core Nades file. Everything stays local to this device.',
  },
  {
    selector: '[data-tour="map-target"]',
    icon: Map,
    title: 'Pick a map to explore',
    copy: 'Choose a map and move from the library into the tactical workspace.',
  },
  {
    selector: '[data-tour="map-selector"]',
    icon: Map,
    title: 'Switch maps quickly',
    copy: 'Open the map selector to jump between available maps without returning to the library.',
  },
  {
    selector: '[data-tour="map-toolbar-actions"]',
    icon: ScanLine,
    title: 'Control the radar view',
    copy: 'Use Focus to hide the side panel, Icons to change marker style, Core and Insta to filter throws, Spawns to show spawn points, and Throw to group by throw position.',
  },
  {
    selector: '[data-tour="map-filters"]',
    icon: SlidersHorizontal,
    title: 'Cut through the noise',
    copy: 'Combine filters for type, side, tournament, team, player, or search. Reset to see the full library again.',
  },
  {
    selector: '[data-tour="visibility-rules"]',
    icon: Eye,
    title: 'Tune what stays visible',
    copy: 'Raise the minimum usage to hide one-off throws and keep only proven lineups on the radar. Lower it to inspect the full library.',
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
  'Загрузите библиотеку раскидок',
  'Выберите карту для изучения',
  'Переключайте карты быстро',
  'Управляйте видом радара',
  'Отсейте лишнее',
  'Настройте видимость',
  'Читайте радар с первого взгляда',
  'Разберитесь в обозначениях',
  'Начните с кластера',
  'Превратите находку в готовый сетап',
];

const russianCopies = [
  'Загрузите grenade_index.json или файл Core Nades. Все данные останутся на этом устройстве.',
  'Выберите карту и перейдите из библиотеки в тактическое рабочее пространство.',
  'Откройте селектор карты, чтобы быстро перейти на другую доступную карту, не возвращаясь в библиотеку.',
  'Кнопки здесь управляют радаром: «Фокус» скрывает боковую панель, «Значки» меняет вид маркеров, «Избранные» и «Инста» фильтруют раскидки, «Спавны» показывает точки появления, а «Бросок» группирует по позиции броска.',
  'Комбинируйте фильтры типа, стороны, турнира, команды, игрока и поиска. Сбросьте их, чтобы увидеть всю библиотеку.',
  'Ползунком «Правила видимости» задайте минимальный порог использований. Повышайте его, чтобы скрыть разовые броски и оставить только проверенные, понижайте — чтобы изучить всю библиотеку.',
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
  importState,
  pathname,
}: OnboardingModalProps) {
  const { locale, tr } = useI18n();
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null);
  const [dialogPosition, setDialogPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [mapTargetAvailable, setMapTargetAvailable] = useState(false);
  const [mapSelectionPending, setMapSelectionPending] = useState(false);
  const target = useMemo(() => {
    if (!started) return null;
    if (step !== 0) return steps[step];
    if (importState === 'complete') {
      return {
        ...steps[0],
        selector: '[data-tour="import-view-maps"]',
        title: tr('Your lineup library is ready', 'Библиотека раскидок готова'),
        copy: tr(
          'The library is imported. Open the map list to choose where to start.',
          'Библиотека импортирована. Откройте список карт и выберите, с чего начать.',
        ),
      };
    }
    if (importState === 'importing') {
      return {
        ...steps[0],
        selector: '[data-tour="import-progress"]',
        title: tr(
          'Importing your lineup library',
          'Импортируем библиотеку раскидок',
        ),
        copy: tr(
          'Keep Nade Viewer open while the library is prepared on this device.',
          'Не закрывайте Nade Viewer, пока библиотека подготавливается на этом устройстве.',
        ),
      };
    }
    return steps[0];
  }, [importState, locale, started, step, tr]);
  const StepIcon = target?.icon;
  const close = useCallback(() => {
    if (!busy) void onComplete();
  }, [busy, onComplete]);
  const dialogRef = useModalAccessibility(!started, close);

  useEffect(() => {
    if (!started) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [close, started]);

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
    if (!started || step !== 8) return;
    const advanceAfterClusterSelection = (event: MouseEvent) => {
      if (
        (event.target as Element | null)?.closest('[data-tour="cluster-list"]')
      ) {
        setStep(9);
      }
    };
    window.addEventListener('click', advanceAfterClusterSelection, true);
    return () =>
      window.removeEventListener('click', advanceAfterClusterSelection, true);
  }, [started, step]);

  useLayoutEffect(() => {
    if (!target) return;
    const observedElement = document.querySelector(target.selector);
    const observedAnchor = resolveAnchor(observedElement, target.dialogAnchor);
    const highlightTargetDirectly =
      step === 0 && importState === 'complete' ? observedElement : null;
    if (highlightTargetDirectly)
      highlightTargetDirectly.classList.add('onboarding-target-active');
    const applyHighlight = (nextRect: DOMRect | null) => {
      if (highlightTargetDirectly) {
        setHighlightRect(null);
        return;
      }
      setHighlightRect(nextRect);
    };
    const update = () => {
      const element = document.querySelector(target.selector);
      const nextRect = (() => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      })();
      const anchorElement = resolveAnchor(element, target.dialogAnchor);
      const anchorRect = anchorElement?.getBoundingClientRect() ?? nextRect;
      const targetVisible = Boolean(nextRect);
      applyHighlight(nextRect);
      if (step === 1) setMapTargetAvailable(targetVisible);
      if (!anchorRect || !dialogRef.current) {
        setDialogPosition(null);
        return;
      }

      const dialogWidth = dialogRef.current.offsetWidth;
      const dialogHeight = dialogRef.current.offsetHeight;
      const margin = 16;
      const gap = 14;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const fitsBelow =
        anchorRect.bottom + gap + dialogHeight <= viewportHeight - margin;
      const fitsAbove = anchorRect.top - gap - dialogHeight >= margin;
      const fitsRight =
        anchorRect.right + gap + dialogWidth <= viewportWidth - margin;
      const fitsLeft = anchorRect.left - gap - dialogWidth >= margin;
      const preferSidePlacement =
        ((step === 2 &&
          element instanceof HTMLElement &&
          element.querySelector('[aria-expanded="true"]')) ||
          step === 5) &&
        element instanceof HTMLElement &&
        (element.hasAttribute('open') ||
          Boolean(element.querySelector('[aria-expanded="true"]')));
      const isViewMapsTransitionStep0Complete = Boolean(
        step === 0 &&
        importState === 'complete' &&
        document.querySelector('[data-tour="import-view-maps"]'),
      );
      const resolvedPreferSidePlacement =
        isViewMapsTransitionStep0Complete || preferSidePlacement;
      let top = fitsBelow
        ? anchorRect.bottom + gap
        : fitsAbove
          ? anchorRect.top - dialogHeight - gap
          : Math.max(margin, (viewportHeight - dialogHeight) / 2);
      let left = Math.min(
        Math.max(margin, anchorRect.left),
        Math.max(margin, viewportWidth - dialogWidth - margin),
      );
      if (step === 0 && fitsLeft && !isViewMapsTransitionStep0Complete) {
        left = anchorRect.left - dialogWidth - gap;
        top = anchorRect.top;
      } else if (isViewMapsTransitionStep0Complete && fitsLeft) {
        left = anchorRect.left - dialogWidth - gap;
        top = anchorRect.top + (anchorRect.height - dialogHeight) / 2;
      } else if (isViewMapsTransitionStep0Complete && fitsRight) {
        left = anchorRect.right + gap;
        top = anchorRect.top + (anchorRect.height - dialogHeight) / 2;
      } else if (preferSidePlacement && fitsRight) {
        left = anchorRect.right + gap;
        top = anchorRect.top;
      } else if (resolvedPreferSidePlacement && fitsLeft) {
        left = anchorRect.left - dialogWidth - gap;
        top = anchorRect.top;
      } else if (!fitsBelow && !fitsAbove && fitsRight)
        left = anchorRect.right + gap;
      else if (!fitsBelow && !fitsAbove && fitsLeft)
        left = anchorRect.left - dialogWidth - gap;
      if (
        !resolvedPreferSidePlacement &&
        !fitsBelow &&
        !fitsAbove &&
        (fitsRight || fitsLeft)
      ) {
        top = anchorRect.bottom - dialogHeight;
      }
      top = Math.min(
        Math.max(margin, top),
        Math.max(margin, viewportHeight - dialogHeight - margin),
      );
      setDialogPosition({ left, top });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new MutationObserver(() => {
      // Re-bind observers if target element was swapped (choose-file -> view-maps)
      const fresh = document.querySelector(target.selector);
      if (fresh && fresh !== observedElement) {
        try {
          observer.observe(fresh, { attributes: true });
        } catch {
          // ignore observer reuse errors
        }
        try {
          resizeObserver.observe(fresh);
        } catch {
          // ignore observer reuse errors
        }
      }
      update();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    if (observedElement)
      observer.observe(observedElement, { attributes: true });
    const resizeObserver = new ResizeObserver(update);
    if (observedElement) resizeObserver.observe(observedElement);
    if (observedAnchor && observedAnchor !== observedElement)
      resizeObserver.observe(observedAnchor);
    if (dialogRef.current) resizeObserver.observe(dialogRef.current);
    return () => {
      highlightTargetDirectly?.classList.remove('onboarding-target-active');
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, [dialogRef, importState, step, target]);

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
      {highlightRect ? (
        <div
          className="onboarding-highlight"
          style={{
            left: highlightRect.left - 5,
            top: highlightRect.top - 5,
            width: highlightRect.width + 10,
            height: highlightRect.height + 10,
          }}
        />
      ) : null}
      <section
        ref={dialogRef}
        className={`onboarding-dialog ${started && step === 0 ? 'onboarding-import-step' : ''}`}
        role="dialog"
        aria-modal={started ? undefined : true}
        aria-labelledby="onboarding-title"
        aria-live={started ? 'polite' : undefined}
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
          {started && step === 0 && importState === 'complete'
            ? tr('Your lineup library is ready', 'Библиотека раскидок готова')
            : started && step === 0 && importState === 'importing'
              ? tr(
                  'Importing your lineup library',
                  'Импортируем библиотеку раскидок',
                )
              : started && locale === 'ru'
                ? russianTitles[step]
                : started
                  ? target?.title
                  : tr(
                      'Welcome to Nade Viewer',
                      'Добро пожаловать в Nade Viewer',
                    )}
        </h1>
        <p>
          {started && step === 0 && importState === 'complete'
            ? tr(
                'The library is imported. Open the map list to choose where to start.',
                'Библиотека импортирована. Откройте список карт и выберите, с чего начать.',
              )
            : started && step === 0 && importState === 'importing'
              ? tr(
                  'Keep Nade Viewer open while the library is prepared on this device.',
                  'Не закрывайте Nade Viewer, пока библиотека подготавливается на этом устройстве.',
                )
              : started && step === 1 && !mapTargetAvailable
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
              <span className="onboarding-next-hint" aria-live="polite">
                {importState === 'complete'
                  ? tr(
                      'Click the highlighted View maps button',
                      'Нажмите выделенную кнопку «К картам»',
                    )
                  : importState === 'importing'
                    ? tr('Import in progress…', 'Импорт выполняется…')
                    : tr(
                        'Click the highlighted Choose file button',
                        'Нажмите выделенную кнопку «Выбрать файл»',
                      )}
              </span>
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
