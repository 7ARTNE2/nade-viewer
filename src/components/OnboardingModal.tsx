import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronLeft,
  CircleHelp,
  ClipboardCheck,
  Database,
  Eye,
  History,
  Layers3,
  Map,
  ScanLine,
  SlidersHorizontal,
  Upload,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
  section: string;
  sectionRu: string;
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
    section: 'Library',
    sectionRu: 'Библиотека',
    title: 'Import a lineup library',
    copy: 'Load grenade_index.json, Core Nades JSON / MessagePack, or a Nadegrid Screenshot ZIP. Drag & drop works too. Everything stays local in SQLite.',
  },
  {
    selector: '[data-tour="recent-history"]',
    dialogAnchor: '[data-tour="recent-history"]',
    icon: History,
    section: 'Library',
    sectionRu: 'Библиотека',
    title: 'Reuse recent work',
    copy: 'Search maps by name, check lineup counts per map, and reopen your last 10 viewed grenades from the left rail. History survives restarts.',
  },
  {
    selector: '[data-tour="map-target"]',
    icon: Map,
    section: 'Library',
    sectionRu: 'Библиотека',
    title: 'Pick a map to explore',
    copy: 'Choose a map tile and move into the tactical workspace. Each tile shows how many lineups hit that map.',
  },
  {
    selector: '[data-tour="map-selector"]',
    icon: Map,
    section: 'Workspace',
    sectionRu: 'Рабочее место',
    title: 'Switch maps without going back',
    copy: 'Open the map selector in the header to jump between available maps. Your filters and view settings are remembered per map.',
  },
  {
    selector: '[data-tour="map-toolbar-actions"]',
    icon: ScanLine,
    section: 'Workspace',
    sectionRu: 'Рабочее место',
    title: 'Control the radar view',
    copy: 'Focus hides the inspector, Icons toggles marker style, Core / Insta filter throws, Spawns shows spawn points, Throw groups by throw position. Nuke and Vertigo also offer Main / Lower radar.',
  },
  {
    selector: '[data-tour="map-filters"]',
    icon: SlidersHorizontal,
    section: 'Workspace',
    sectionRu: 'Рабочее место',
    title: 'Narrow by type, side, and match',
    copy: 'Combine grenade type, side, and free-text search with Tournament → Team → Player. Picking a team limits the player list. Reset clears filters and the selected cluster.',
  },
  {
    selector: '[data-tour="visibility-rules"]',
    icon: Eye,
    section: 'Workspace',
    sectionRu: 'Рабочее место',
    title: 'Tune what stays visible',
    copy: 'Raise Minimum usage to hide one-off throws and keep only proven lineups. Lower it to inspect the full library. The value is stored locally and applied per map.',
  },
  {
    selector: '[data-tour="map-canvas"]',
    icon: ScanLine,
    section: 'Radar',
    sectionRu: 'Радар',
    title: 'Read the radar at a glance',
    copy: 'Scroll to zoom, drag to pan when zoomed, use +/- and 0 to reset, arrow keys to pan. Right-click any lineup point to copy its setpos / setang command.',
  },
  {
    selector: '[data-tour="map-legend"]',
    icon: CircleHelp,
    section: 'Radar',
    sectionRu: 'Радар',
    title: 'Decode every mark',
    copy: 'The legend explains T / CT / Mix cluster colors, grenade types, trajectory lines, stacked points (numbers), Core gold rings, Insta spawn matches, and pulsing spawns. Click a spawn to copy it.',
  },
  {
    selector: '[data-tour="cluster-list"]',
    icon: Layers3,
    section: 'Radar',
    sectionRu: 'Радар',
    title: 'Start with a cluster',
    copy: 'Nearby landings or throw positions are grouped. Pick a cluster here or directly on the radar — the camera will fly to it and load up to 30 lineups per page.',
  },
  {
    selector: '[data-tour="grenade-list"]',
    icon: ClipboardCheck,
    section: 'Radar',
    sectionRu: 'Радар',
    title: 'Turn a find into a setup',
    copy: 'Click any row to open the full detail, Copy the console command, or toggle Core. Insta badges mark spawn-aligned throws; throw-key icons and usage / airtime / round are shown inline.',
  },
  {
    selector: '[data-tour="library-switcher"]',
    icon: Database,
    section: 'System',
    sectionRu: 'Система',
    title: 'Manage library snapshots',
    copy: 'Switch the active Snapshot from the header, rename it in place, and see grenade counts at a glance. Each import is isolated — switching never merges data.',
  },
  {
    selector: '[data-tour="library-actions"]',
    icon: BadgeCheck,
    section: 'System',
    sectionRu: 'Система',
    title: 'Export Core & keep it fresh',
    copy: 'Open the … menu to export Core Nades to core_nades.json, check the online library manifest, download a compressed update, or delete the active library. Updates only replace data on success.',
  },
  {
    selector: '[data-tour="topbar-tools"]',
    icon: Wrench,
    section: 'System',
    sectionRu: 'Система',
    title: 'Extend with Tools · EN / RU',
    copy: 'Visit Tools for local plugins (e.g., demo parser). Switch EN / RU in the top bar — layouts handle Russian expansion. Per-map view state (filters, spawns, radar level, icons) persists locally.',
  },
];

const russianTitles = [
  'Загрузите библиотеку раскидок',
  'Возвращайтесь быстрее',
  'Выберите карту для изучения',
  'Переключайте карты на лету',
  'Управляйте видом радара',
  'Фильтруйте по типу, стороне и матчу',
  'Настройте видимость',
  'Читайте радар с первого взгляда',
  'Разберитесь в обозначениях',
  'Начните с кластера',
  'Превратите находку в готовый сетап',
  'Управляйте снимками библиотеки',
  'Экспортируйте Core и обновляйте библиотеку',
  'Расширяйте инструментами · EN / RU',
];

const russianCopies = [
  'Загрузите grenade_index.json, Core Nades в JSON / MessagePack или ZIP скриншотов Nadegrid. Можно перетаскиванием — всё остаётся локально в SQLite.',
  'Ищите карты по названию, смотрите счётчики раскидок на тайлах и открывайте 10 последних просмотренных гранат слева. История сохраняется после перезапуска.',
  'Выберите тайл карты, чтобы перейти в тактическое рабочее пространство. На тайле видно, сколько раскидок приходится на карту.',
  'Откройте селектор карты в шапке, чтобы прыгать между доступными картами. Фильтры и настройки вида запоминаются для каждой карты отдельно.',
  '«Фокус» скрывает инспектор, «Значки» меняет вид маркеров, «Избранные» и «Инста» фильтруют раскидки, «Спавны» показывает точки появления, «Бросок» группирует по позиции броска. На Nuke и Vertigo есть переключение Основной / Нижний.',
  'Совмещайте тип гранаты, сторону и поиск с цепочкой Турнир → Команда → Игрок. Выбор команды сужает список игроков. «Сбросить» очищает фильтры и выбранный кластер.',
  'Ползунком «Правила видимости» задайте минимальный порог использований. Повышайте, чтобы скрыть разовые броски и оставить только проверенные; понижайте — чтобы изучить всю библиотеку. Хранится локально для каждой карты.',
  'Колесом — масштаб, перетаскиванием — перемещение при приближении, +/- и 0 — зум и сброс, стрелками — сдвиг. ПКМ по точке раскидки — копировать команду setpos / setang.',
  'Легенда объясняет цвета кластеров T / CT / Mix, типы гранат, линии траекторий, стопки (цифры), золотые кольца Core, метки Insta и пульсирующие спавны. Нажмите на спавн, чтобы скопировать.',
  'Близкие точки приземления или броска объединены в группы. Выберите кластер здесь или прямо на радаре — камера подлетит к нему и загрузит до 30 раскидок на страницу.',
  'Нажмите строку, чтобы открыть детали, «Копировать» — для команды консоли, или переключите Core. Метка Insta подсвечивает совпадение со спавном; иконки клавиш броска и метрики usage / airtime / round — прямо в строке.',
  'Переключайте активный снимок в шапке, переименовывайте на месте и видите счётчики гранат. Каждый импорт изолирован — переключение не смешивает данные.',
  'Откройте меню «…», чтобы экспортировать Core в core_nades.json, проверить онлайн-библиотеку по манифесту, скачать сжатое обновление или удалить активную библиотеку. Данные заменяются только при успешном импорте.',
  'Откройте «Инструменты» для локальных плагинов (например, парсер демо). Переключайте EN / RU вверху — верстка учитывает длину русского. Состояние вида для каждой карты (фильтры, спавны, уровень радара, значки) сохраняется локально.',
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
  const [recentHistoryAvailable, setRecentHistoryAvailable] = useState(false);
  const [mapSelectionPending, setMapSelectionPending] = useState(false);
  const [targetAvailable, setTargetAvailable] = useState(false);
  const furthestStepRef = useRef(0);
  const startButtonRef = useRef<HTMLButtonElement>(null);
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
        section: steps[0].section,
        sectionRu: steps[0].sectionRu,
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
        section: steps[0].section,
        sectionRu: steps[0].sectionRu,
      };
    }
    return steps[0];
  }, [importState, locale, started, step, tr]);
  const StepIcon = target?.icon;

  useEffect(() => {
    furthestStepRef.current = Math.max(furthestStepRef.current, step);
  }, [step]);

  const close = useCallback(() => {
    if (!busy) void onComplete();
  }, [busy, onComplete]);
  const dialogRef = useModalAccessibility(!started, close);

  useEffect(() => {
    if (!started) startButtonRef.current?.focus();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'ArrowRight' && step < steps.length - 1) {
        event.preventDefault();
        setStep((v) => Math.min(steps.length - 1, v + 1));
      }
      if (event.key === 'ArrowLeft' && step > 0) {
        event.preventDefault();
        setStep((v) => Math.max(0, v - 1));
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [close, started, step]);

  useEffect(() => {
    if (!started) return;
    if (activeImport && pathname === '/maps')
      setStep((value) => Math.max(value, 1));
    if (pathname.startsWith('/map/')) {
      setMapSelectionPending(false);
      setStep((value) => Math.max(value, 3));
    }
  }, [activeImport, pathname, started]);

  useEffect(() => {
    if (!started) return;
    // step 2 is the map-target tile — clicking it should hint "opening map"
    if (step !== 2) return;
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
    if (!started || step !== 9) return;
    const advanceAfterClusterSelection = (event: MouseEvent) => {
      if (
        (event.target as Element | null)?.closest('[data-tour="cluster-list"]')
      ) {
        setStep(10);
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
      const openLegend =
        step === 8 &&
        element?.getAttribute('aria-expanded') === 'true'
          ? document.querySelector('.map-legend.is-visible')
          : null;
      const anchorElement =
        openLegend ?? resolveAnchor(element, target.dialogAnchor);
      const anchorRect = anchorElement?.getBoundingClientRect() ?? nextRect;
      const isVisible = Boolean(nextRect);
      applyHighlight(nextRect);
      setTargetAvailable(isVisible);
      if (step === 1) setRecentHistoryAvailable(isVisible);
      if (step === 2) setMapTargetAvailable(isVisible);
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
        ((step === 3 &&
          element instanceof HTMLElement &&
          element.querySelector('[aria-expanded="true"]')) ||
          step === 6 ||
          Boolean(openLegend)) &&
        element instanceof HTMLElement &&
        (Boolean(openLegend) ||
          element.hasAttribute('open') ||
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
      // If target not visible, center dialog instead of anchoring off-screen
      if (!isVisible) {
        setDialogPosition(null);
        return;
      }
      setDialogPosition({ left, top });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new MutationObserver(() => {
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

  const canGoBack = started && step > 0;
  const canGoNext = started && step < steps.length - 1 && targetAvailable;
  const isLastStep = started && step === steps.length - 1;

  const currentSectionLabel =
    started && target
      ? locale === 'ru'
        ? target.sectionRu.toUpperCase()
        : target.section.toUpperCase()
      : null;

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
        className={`onboarding-dialog ${started && step === 0 ? 'onboarding-import-step' : ''} ${!targetAvailable && started ? 'onboarding-centered' : ''}`}
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
              {currentSectionLabel ?? tr('TUTORIAL', 'ТУТОРИАЛ')}
            </span>
            <div className="onboarding-progress-track" aria-hidden="true">
              {steps.map((tourStep, index) => {
                const isActive = index <= step;
                const isCurrent = index === step;
                return (
                  <button
                    key={tourStep.selector + index}
                    type="button"
                    className={`onboarding-dot ${isActive ? 'active' : ''} ${isCurrent ? 'current' : ''}`}
                    aria-label={tr(
                      `Go to step ${index + 1}`,
                      `Перейти к шагу ${index + 1}`,
                    )}
                    aria-current={isCurrent ? 'step' : undefined}
                    disabled={busy}
                    onClick={() => {
                      // allow free navigation backward, and forward only to visited+1
                      if (
                        index <= furthestStepRef.current + 1 ||
                        index < step
                      ) {
                        setStep(index);
                        // auto-navigate for section jumps
                        if (index <= 2 && pathname !== '/maps' && pathname !== '/import') {
                          // stay where we are, dialog will be centered with hint
                        }
                        if (index >= 3 && index <= 10 && !pathname.startsWith('/map/') && activeImport) {
                          // hint will tell user to pick a map; don't force navigation
                        }
                      }
                    }}
                  />
                );
              })}
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
              : started && step === 1 && !recentHistoryAvailable
                ? tr(
                    'Open the Maps page to see your recent grenades and map search. Import a library first if the list is empty.',
                    'Откройте страницу Карт, чтобы увидеть недавние гранаты и поиск по картам. Если список пуст — сначала импортируйте библиотеку.',
                  )
                : started && step === 2 && !mapTargetAvailable
                ? tr(
                    'This library has no maps to show yet. Import a non-empty grenade library to continue the tour, or skip it.',
                    'В этой библиотеке пока нет карт. Импортируйте непустую библиотеку гранат, чтобы продолжить обучение, или пропустите его.',
                  )
                : started && !targetAvailable
                  ? tr(
                      'This part of the interface is not visible right now. Use Next to continue — you can revisit any step from the dots above.',
                      'Этот элемент сейчас не виден. Нажмите «Далее», чтобы продолжить — к любому шагу можно вернуться по точкам выше.',
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
                ref={startButtonRef}
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
              recentHistoryAvailable ? (
                <div className="onboarding-nav-group">
                  <button
                    className="btn onboarding-back"
                    type="button"
                    disabled={busy}
                    onClick={() => setStep((v) => Math.max(0, v - 1))}
                    aria-label={tr('Back', 'Назад')}
                  >
                    <ChevronLeft size={15} />
                    {tr('Back', 'Назад')}
                  </button>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => setStep((v) => v + 1)}
                  >
                    {tr('Next tip', 'Далее')}
                    <ArrowRight size={15} />
                  </button>
                </div>
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
            ) : step === 2 ? (
              mapTargetAvailable ? (
                <div className="onboarding-nav-group">
                  <button
                    className="btn onboarding-back"
                    type="button"
                    disabled={busy}
                    onClick={() => setStep((v) => Math.max(0, v - 1))}
                  >
                    <ChevronLeft size={15} />
                    {tr('Back', 'Назад')}
                  </button>
                  <span className="onboarding-next-hint">
                    {mapSelectionPending
                      ? tr('Opening map...', 'Открываем карту...')
                      : tr(
                          'Click the highlighted map to continue',
                          'Нажмите на выделенную карту, чтобы продолжить',
                        )}
                  </span>
                </div>
              ) : (
                <div className="onboarding-nav-group">
                  <button
                    className="btn onboarding-back"
                    type="button"
                    disabled={busy}
                    onClick={() => setStep((v) => Math.max(0, v - 1))}
                  >
                    <ChevronLeft size={15} />
                    {tr('Back', 'Назад')}
                  </button>
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
                </div>
              )
            ) : isLastStep ? (
              <div className="onboarding-nav-group">
                <button
                  className="btn onboarding-back"
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((v) => Math.max(0, v - 1))}
                >
                  <ChevronLeft size={15} />
                  {tr('Back', 'Назад')}
                </button>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() => run(onComplete)}
                >
                  {tr('Finish', 'Завершить')}
                  <Check size={15} />
                </button>
              </div>
            ) : !targetAvailable ? (
              <div className="onboarding-nav-group">
                <button
                  className="btn onboarding-back"
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((v) => Math.max(0, v - 1))}
                >
                  <ChevronLeft size={15} />
                  {tr('Back', 'Назад')}
                </button>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((v) => v + 1)}
                >
                  {tr('Next tip', 'Далее')}
                  <ArrowRight size={15} />
                </button>
              </div>
            ) : canGoNext ? (
              <div className="onboarding-nav-group">
                <button
                  className="btn onboarding-back"
                  type="button"
                  disabled={busy || !canGoBack}
                  onClick={() => setStep((v) => Math.max(0, v - 1))}
                >
                  <ChevronLeft size={15} />
                  {tr('Back', 'Назад')}
                </button>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((v) => v + 1)}
                >
                  {tr('Next tip', 'Далее')}
                  <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              <div className="onboarding-nav-group">
                <button
                  className="btn onboarding-back"
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((v) => Math.max(0, v - 1))}
                >
                  <ChevronLeft size={15} />
                  {tr('Back', 'Назад')}
                </button>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() => setStep((v) => v + 1)}
                >
                  {tr('Next tip', 'Далее')}
                  <ArrowRight size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
        {started ? (
          <div className="onboarding-keyhint" aria-hidden="true">
            <span>
              <ArrowLeft size={11} /> {tr('Back', 'Назад')}
            </span>
            <span>
              {tr('Next', 'Далее')} <ArrowRight size={11} />
            </span>
            <span>Esc {tr('Skip', 'Пропуск')}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
