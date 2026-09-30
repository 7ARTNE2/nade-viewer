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
  Languages,
  Layers3,
  Map,
  ScanLine,
  Crosshair,
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
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useModalAccessibility } from '../lib/useModalAccessibility';

type OnboardingModalProps = {
  onComplete: () => Promise<void>;
  onShowImport: () => void;
  onShowMaps: () => void;
  activeImport: boolean;
  importState: 'idle' | 'importing' | 'complete';
  pathname: string;
  onStepChange: (step: number | null) => void;
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

type DialogPosition = { left: number; top: number };

function placeTourDialog(
  anchor: DOMRect,
  protectedRects: DOMRect[],
  radarRect: DOMRect | null,
  dialogWidth: number,
  dialogHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): DialogPosition {
  const margin = 16;
  const gap = 14;
  const clamp = (value: number, limit: number) =>
    Math.min(Math.max(margin, value), Math.max(margin, limit - margin));
  const left = anchor.left - dialogWidth - gap;
  const right = anchor.right + gap;
  const above = anchor.top - dialogHeight - gap;
  const below = anchor.bottom + gap;
  const centerX = anchor.left + (anchor.width - dialogWidth) / 2;
  const centerY = anchor.top + (anchor.height - dialogHeight) / 2;
  const candidates: DialogPosition[] = [
    ...[anchor.left, centerX, anchor.right - dialogWidth].flatMap((x) => [
      { left: x, top: below },
      { left: x, top: above },
    ]),
    ...[anchor.top, centerY, anchor.bottom - dialogHeight].flatMap((y) => [
      { left: right, top: y },
      { left, top: y },
    ]),
    ...(radarRect
      ? [
          { left: radarRect.right + gap, top: radarRect.top },
          { left: radarRect.right + gap, top: radarRect.bottom - dialogHeight },
          { left: radarRect.left - dialogWidth - gap, top: radarRect.top },
          {
            left: radarRect.left - dialogWidth - gap,
            top: radarRect.bottom - dialogHeight,
          },
          { left: radarRect.left, top: radarRect.top - dialogHeight - gap },
          { left: radarRect.left, top: radarRect.bottom + gap },
        ]
      : []),
    ...[margin, viewportWidth - dialogWidth - margin].flatMap((x) => [
      { left: x, top: margin },
      { left: x, top: viewportHeight - dialogHeight - margin },
    ]),
  ];
  const overlap = (position: DialogPosition, rect: DOMRect) =>
    Math.max(
      0,
      Math.min(position.left + dialogWidth, rect.right) -
        Math.max(position.left, rect.left),
    ) *
    Math.max(
      0,
      Math.min(position.top + dialogHeight, rect.bottom) -
        Math.max(position.top, rect.top),
    );
  let best = { left: margin, top: margin };
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const position = {
      left: clamp(candidate.left, viewportWidth - dialogWidth),
      top: clamp(candidate.top, viewportHeight - dialogHeight),
    };
    const coveredArea = protectedRects.reduce(
      (total, rect) => total + overlap(position, rect),
      0,
    );
    const distance = Math.hypot(
      position.left + dialogWidth / 2 - (anchor.left + anchor.width / 2),
      position.top + dialogHeight / 2 - (anchor.top + anchor.height / 2),
    );
    // Never cover the active control when another placement is available.
    const radarArea = radarRect ? overlap(position, radarRect) : 0;
    const score = coveredArea * 10000 + radarArea * 10 + distance;
    if (score < bestScore) {
      best = position;
      bestScore = score;
    }
  }
  return best;
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
    copy: 'Scroll to zoom, drag to pan when zoomed, use +/- and 0 to reset, and use arrow keys to pan. Click a cluster to focus it, click a lineup point to open it (or choose from a stack), click a spawn to copy its command, and right-click a lineup point to copy setpos / setang.',
  },
  {
    selector: '[data-tour-action="cluster-click"]',
    icon: Layers3,
    section: 'Radar practice',
    sectionRu: 'Практика радара',
    title: 'Focus a cluster',
    copy: 'Click a numbered cluster on the radar. The camera will focus on it and load its lineups.',
  },
  {
    selector: '[data-tour-action="throw-stack"]',
    icon: Layers3,
    section: 'Radar practice',
    sectionRu: 'Практика радара',
    title: 'Open a lineup stack',
    copy: 'Click a numbered stack to reveal its lineup points below the radar. Right-click any revealed point to copy its setpos / setang command.',
  },
  {
    selector: '[data-tour-action-context="grenade-contextmenu"]',
    icon: ScanLine,
    section: 'Radar practice',
    sectionRu: 'Практика радара',
    title: 'Copy lineup coordinates',
    copy: 'Right-click an individual lineup point directly on the radar, or a point in an opened stack, to copy its setpos / setang command.',
  },
  {
    selector: '[data-tour-action="spawn-click"]',
    icon: Crosshair,
    section: 'Radar practice',
    sectionRu: 'Практика радара',
    title: 'Copy a spawn command',
    copy: 'Click a pulsing spawn marker to copy its setpos / setang command.',
  },
  {
    selector: '[data-tour-action="throw-single"]',
    icon: ClipboardCheck,
    section: 'Radar practice',
    sectionRu: 'Практика радара',
    title: 'Open a lineup',
    copy: 'Single lineup points on the radar also support right-click to copy setpos / setang. Left-click one to open its full details; the tutorial will continue there.',
  },
  {
    selector: '[data-tour="grenade-core-toggle"]',
    icon: BadgeCheck,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Save a useful lineup',
    copy: 'Add this lineup to Core so it stays easy to find in your library.',
  },
  {
    selector: '[data-tour="grenade-overview"]',
    icon: ScanLine,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Explore the lineup details',
    copy: 'The radar shows the throw point and trajectory. The header identifies the grenade type, side, thrower and team; these metrics show airtime, round time, usage count and tickrate.',
  },
  {
    selector: '[data-tour="grenade-throw-keys"]',
    icon: Crosshair,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Check the throw keys and screenshots',
    copy: 'Throw keys show the inputs for the lineup. When screenshots are available, they appear after the coordinates: open a normal or wide view to compare your position and aim.',
  },
  {
    selector: '[data-tour="grenade-copy-coordinates"]',
    icon: ClipboardCheck,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Copy the lineup command',
    copy: 'Copy the setpos / setang command from the coordinates panel.',
  },
  {
    selector: '[data-tour="grenade-demo-metadata"]',
    icon: Database,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Trace the source demo',
    copy: 'Demo metadata gives the source file and throw tick, so you can locate the exact moment this lineup was recorded.',
  },
  {
    selector: '[data-tour="grenade-usage"]',
    icon: History,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'See how this lineup was used',
    copy: 'Usage history charts throws over time. The panel names the player and team that used this lineup most often, and shows its last recorded demo and tick.',
  },
  {
    selector: '[data-tour="grenade-throwers"]',
    icon: History,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Find who used it',
    copy: 'The throwers list names players who used this lineup. Click a name to search their throws on the map.',
  },
  {
    selector: '[data-tour="grenade-similar"]',
    icon: Layers3,
    section: 'Lineup details',
    sectionRu: 'Детали раскидки',
    title: 'Compare similar lineups',
    copy: 'Browse nearby or related grenades here. Open one for its details, copy its command, or save it to Core.',
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
    title: 'Extend with Tools',
    copy: 'Visit Tools to open local plugins, such as the demo parser.',
  },
  {
    selector: '[data-tour="language-switch"]',
    icon: Languages,
    section: 'System',
    sectionRu: 'Система',
    title: 'Switch the interface language',
    copy: 'Choose EN or RU in the top bar. The layout adapts to Russian, and your per-map view settings stay saved.',
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
  'Сфокусируйтесь на кластере',
  'Откройте стопку раскидок',
  'Скопируйте координаты раскидки',
  'Скопируйте команду спавна',
  'Откройте раскидку',
  'Сохраните раскидку в Core',
  'Изучите страницу раскидки',
  'Проверьте клавиши и скриншоты',
  'Скопируйте команду раскидки',
  'Найдите исходное демо',
  'Посмотрите статистику использования',
  'Узнайте, кто бросал гранату',
  'Сравните похожие раскидки',
  'Разберитесь в обозначениях',
  'Начните с кластера',
  'Превратите находку в готовый сетап',
  'Управляйте снимками библиотеки',
  'Экспортируйте Core и обновляйте библиотеку',
  'Откройте инструменты',
  'Переключите язык интерфейса',
];

const russianCopies = [
  'Загрузите grenade_index.json, Core Nades в JSON / MessagePack или ZIP скриншотов Nadegrid. Можно перетаскиванием — всё остаётся локально в SQLite.',
  'Ищите карты по названию, смотрите счётчики раскидок на тайлах и открывайте 10 последних просмотренных гранат слева. История сохраняется после перезапуска.',
  'Выберите тайл карты, чтобы перейти в тактическое рабочее пространство. На тайле видно, сколько раскидок приходится на карту.',
  'Откройте селектор карты в шапке, чтобы прыгать между доступными картами. Фильтры и настройки вида запоминаются для каждой карты отдельно.',
  '«Фокус» скрывает инспектор, «Значки» меняет вид маркеров, «Избранные» и «Инста» фильтруют раскидки, «Спавны» показывает точки появления, «Бросок» группирует по позиции броска. На Nuke и Vertigo есть переключение Основной / Нижний.',
  'Совмещайте тип гранаты, сторону и поиск с цепочкой Турнир → Команда → Игрок. Выбор команды сужает список игроков. «Сбросить» очищает фильтры и выбранный кластер.',
  'Ползунком «Правила видимости» задайте минимальный порог использований. Повышайте, чтобы скрыть разовые броски и оставить только проверенные; понижайте — чтобы изучить всю библиотеку. Хранится локально для каждой карты.',
  'Колесом — масштаб, перетаскиванием — перемещение при приближении, +/- и 0 — зум и сброс, стрелками — сдвиг. Нажмите кластер, чтобы сфокусироваться на нём; точку раскидки — чтобы открыть её или выбрать из стопки; спавн — чтобы скопировать команду. ПКМ по точке раскидки копирует setpos / setang.',
  'Нажмите пронумерованный кластер на радаре. Камера сфокусируется на нём и загрузит его раскидки.',
  'Нажмите пронумерованную стопку, чтобы раскрыть точки под радаром. Правый клик по любой из них копирует команду setpos / setang.',
  'Нажмите ПКМ по одиночной точке на радаре или по точке в раскрытой стопке, чтобы скопировать setpos / setang.',
  'Нажмите на пульсирующий спавн, чтобы скопировать команду setpos / setang.',
  'Одиночную точку на радаре тоже можно нажать правой кнопкой, чтобы скопировать setpos / setang. Нажмите левой кнопкой, чтобы открыть детали и продолжить обучение.',
  'Добавьте эту раскидку в Core, чтобы быстро находить её в библиотеке.',
  'На радаре видны точка броска и траектория. В шапке указаны тип гранаты, сторона, игрок и команда. Здесь показаны время полёта, момент раунда, число использований и тикрейт.',
  'Клавиши подсказывают, что нажимать для броска. Если доступны скриншоты, они расположены после координат: откройте обычный или широкий вид, чтобы сверить позицию и прицел.',
  'Скопируйте команду setpos / setang в блоке координат.',
  'Здесь указан файл демо и тик броска — по ним можно найти точный момент записи раскидки.',
  'График показывает историю бросков. Здесь же указаны игрок и команда, которые чаще всего использовали раскидку, а также последнее демо и тик.',
  'Здесь перечислены игроки, использовавшие раскидку. Нажмите на имя, чтобы найти их броски на карте.',
  'Ниже показаны похожие гранаты. Можно открыть детали, скопировать команду или добавить раскидку в Core.',
  'Легенда объясняет цвета кластеров T / CT / Mix, типы гранат, линии траекторий, стопки (цифры), золотые кольца Core, метки Insta и пульсирующие спавны. Нажмите на спавн, чтобы скопировать.',
  'Близкие точки приземления или броска объединены в группы. Выберите кластер здесь или прямо на радаре — камера подлетит к нему и загрузит до 30 раскидок на страницу.',
  'Нажмите строку, чтобы открыть детали, «Копировать» — для команды консоли, или переключите Core. Метка Insta подсвечивает совпадение со спавном; иконки клавиш броска и метрики usage / airtime / round — прямо в строке.',
  'Переключайте активный снимок в шапке, переименовывайте на месте и видите счётчики гранат. Каждый импорт изолирован — переключение не смешивает данные.',
  'Откройте меню «…», чтобы экспортировать Core в core_nades.json, проверить онлайн-библиотеку по манифесту, скачать сжатое обновление или удалить активную библиотеку. Данные заменяются только при успешном импорте.',
  'Откройте «Инструменты» для локальных плагинов, например парсера демо.',
  'Переключайте EN / RU вверху. Верстка учитывает длину русского, а состояние вида для каждой карты сохраняется локально.',
];

export default function OnboardingModal({
  onComplete,
  onShowImport,
  onShowMaps,
  activeImport,
  importState,
  pathname,
  onStepChange,
}: OnboardingModalProps) {
  const navigate = useNavigate();
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
  const radarPathRef = useRef<string | null>(null);
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
    onStepChange(started && pathname.startsWith('/map/') ? step : null);
    return () => onStepChange(null);
  }, [onStepChange, pathname, started, step]);

  useEffect(() => {
    furthestStepRef.current = Math.max(furthestStepRef.current, step);
  }, [step]);

  useEffect(() => {
    if (!started || step < 21 || !pathname.startsWith('/grenade/')) return;
    if (radarPathRef.current) navigate(radarPathRef.current);
    else
      document
        .querySelector<HTMLButtonElement>('[data-tour="grenade-back-to-map"]')
        ?.click();
  }, [navigate, pathname, started, step]);

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
    if (pathname.startsWith('/grenade/')) {
      setStep((value) => Math.max(value, 13));
    } else if (pathname.startsWith('/map/')) {
      radarPathRef.current = pathname;
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
    if (!started || !pathname.startsWith('/map/')) return;
    const actionSteps: Record<number, string> = {
      8: 'cluster-click',
      9: 'throw-stack',
      10: 'grenade-contextmenu',
      11: 'spawn-click',
      12: 'throw-single',
    };
    const action = actionSteps[step];
    if (!action) return;
    const eventName =
      action === 'grenade-contextmenu' ? 'contextmenu' : 'click';
    const handleAction = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const selector =
        action === 'grenade-contextmenu'
          ? `[data-tour-action-context="${action}"]`
          : `[data-tour-action="${action}"]`;
      if (!target?.closest(selector)) return;
      setStep((value) => value + 1);
    };
    window.addEventListener(eventName, handleAction, true);
    return () => window.removeEventListener(eventName, handleAction, true);
  }, [pathname, started, step]);

  useEffect(() => {
    if (!started || !pathname.startsWith('/grenade/')) return;
    const detailActions: Record<number, string> = {
      13: 'grenade-core-toggle',
      16: 'grenade-copy-coordinates',
    };
    const action = detailActions[step];
    if (!action) return;
    const handleAction = (event: MouseEvent) => {
      if (
        (event.target as Element | null)?.closest(`[data-tour="${action}"]`)
      ) {
        setStep((value) => value + 1);
      }
    };
    window.addEventListener('click', handleAction, true);
    return () => window.removeEventListener('click', handleAction, true);
  }, [pathname, started, step]);

  useLayoutEffect(() => {
    if (
      !started ||
      !pathname.startsWith('/grenade/') ||
      step < 13 ||
      step > 20 ||
      !target
    )
      return;
    const revealTarget = () => {
      const element = document.querySelector(target.selector);
      if (!element) return false;
      element.scrollIntoView({
        block: 'start',
        inline: 'nearest',
        behavior: 'instant',
      });
      return true;
    };
    if (revealTarget()) return;
    const observer = new MutationObserver(() => {
      if (revealTarget()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname, started, step, target]);

  useLayoutEffect(() => {
    if (!target) return;
    // Select the spawn only after the radar has returned to its overview.
    // Keep that choice for the rest of this step as the camera or DOM updates.
    let selectedSpawn: Element | null = null;
    const findTarget = () => {
      if (step === 11) {
        if (selectedSpawn?.isConnected) return selectedSpawn;
        const camera = document.querySelector<HTMLElement>('.map-camera');
        const scale = Number(
          camera?.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1,
        );
        if (
          !camera ||
          camera.classList.contains('is-animating') ||
          scale > 1.01
        )
          return null;
        const viewport = document
          .querySelector('.map-viewport')
          ?.getBoundingClientRect();
        if (!viewport) return null;
        const strip = document
          .querySelector('.throw-strip')
          ?.getBoundingClientRect();
        const visibleSpawns = [
          ...document.querySelectorAll(target.selector),
        ].filter((spawn) => {
          const rect = spawn.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= viewport.left &&
            rect.right <= viewport.right &&
            rect.top >= viewport.top &&
            rect.bottom <= viewport.bottom &&
            (!strip ||
              rect.right <= strip.left ||
              rect.left >= strip.right ||
              rect.bottom <= strip.top ||
              rect.top >= strip.bottom)
          );
        });
        const throwMarkers = [
          ...document.querySelectorAll(
            '.marker-layer [data-tour-action="throw-stack"], .marker-layer [data-tour-action="throw-single"], .marker-layer [data-tour-action="cluster-click"]',
          ),
        ].map((marker) => marker.getBoundingClientRect());
        const clearance = (spawn: Element) => {
          const rect = spawn.getBoundingClientRect();
          // The outline also needs room around the spawn marker.
          return Math.min(
            Infinity,
            ...throwMarkers.map((marker) =>
              Math.max(
                marker.left - rect.right,
                rect.left - marker.right,
                marker.top - rect.bottom,
                rect.top - marker.bottom,
              ),
            ),
          );
        };
        const distanceFromCenter = (spawn: Element) => {
          const rect = spawn.getBoundingClientRect();
          return Math.hypot(
            (rect.left + rect.right - viewport.left - viewport.right) / 2,
            (rect.top + rect.bottom - viewport.top - viewport.bottom) / 2,
          );
        };
        selectedSpawn =
          visibleSpawns.sort((first, second) => {
            const firstClearance = clearance(first);
            const secondClearance = clearance(second);
            const firstFree = firstClearance >= 8;
            const secondFree = secondClearance >= 8;
            if (firstFree !== secondFree) return firstFree ? -1 : 1;
            if (!firstFree && firstClearance !== secondClearance)
              return secondClearance - firstClearance;
            return distanceFromCenter(first) - distanceFromCenter(second);
          })[0] ?? null;
        return selectedSpawn;
      }
      return (
        (step === 10
          ? document.querySelector(
              '.throw-strip [data-tour-action-context="grenade-contextmenu"]',
            )
          : null) ?? document.querySelector(target.selector)
      );
    };
    const observedElement =
      findTarget() ??
      (step === 2 ? document.querySelector('[data-tour="map-tile"]') : null);
    const observedAnchor = resolveAnchor(observedElement, target.dialogAnchor);
    // Keep track of every marker highlighted while React replaces map controls.
    const highlightedTargets = new Set<Element>();
    const highlightDirectTarget = (element: Element | null) => {
      for (const previous of highlightedTargets) {
        if (previous !== element) {
          previous.classList.remove('onboarding-target-active');
          highlightedTargets.delete(previous);
        }
      }
      if (element && !element.classList.contains('onboarding-target-active')) {
        element.classList.add('onboarding-target-active');
        highlightedTargets.add(element);
      }
    };
    const directTargetFor = (element: Element | null) =>
      (step >= 8 && step <= 12) || step === 13 || step === 16 || step >= 24
        ? target.selector === '[data-tour="language-switch"]'
          ? element
          : (element?.querySelector('button') ?? element)
        : null;
    highlightDirectTarget(directTargetFor(observedElement));
    const applyHighlight = (nextRect: DOMRect | null) => {
      if (
        (step >= 8 && step <= 12) ||
        step === 13 ||
        step === 16 ||
        step >= 24
      ) {
        setHighlightRect(null);
        return;
      }
      setHighlightRect(nextRect);
    };
    const update = () => {
      const element =
        findTarget() ??
        (step === 2
          ? document.querySelector(
              '[data-tour="map-target"], [data-tour="map-tile"]',
            )
          : null);
      highlightDirectTarget(directTargetFor(element));
      const nextRect = (() => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      })();
      const mapMenu =
        step === 3 ? element?.querySelector('.map-selector-menu') : null;
      const mapTriggerRect =
        step === 3
          ? element
              ?.querySelector('.map-selector-trigger')
              ?.getBoundingClientRect()
          : null;
      // Reserve the dropdown's space before it opens so the card never blocks
      // its options on the first click.
      const mapMenuRect =
        mapMenu?.getBoundingClientRect() ??
        (mapTriggerRect
          ? new DOMRect(
              mapTriggerRect.left,
              mapTriggerRect.bottom + 7,
              Math.min(164, window.innerWidth - 24),
              Math.min(380, window.innerHeight - 100),
            )
          : null);
      const openLegend =
        step === 21 && element?.getAttribute('aria-expanded') === 'true'
          ? document.querySelector('.map-legend.is-visible')
          : null;
      const openLibraryMenu =
        step === 24
          ? document.querySelector('.snapshot-menu')
          : step === 25
            ? document.querySelector('.library-actions-popover')
            : null;
      const openThrowStack =
        step === 10 || step === 11
          ? document.querySelector('.throw-strip')
          : null;
      const anchorElement =
        openThrowStack ??
        openLegend ??
        openLibraryMenu ??
        resolveAnchor(element, target.dialogAnchor);
      const radarViewport =
        step >= 9 && step <= 12
          ? (document.querySelector('.map-viewport')?.getBoundingClientRect() ??
            null)
          : null;
      const anchorRect =
        mapMenuRect ??
        anchorElement?.getBoundingClientRect() ??
        nextRect ??
        radarViewport;
      const directTarget = directTargetFor(element);
      const directRect = directTarget?.getBoundingClientRect();
      const visibleRect =
        (step >= 8 && step <= 12) || step === 13 || step === 16 || step >= 24
          ? directRect
          : nextRect;
      const isVisible = Boolean(
        visibleRect && visibleRect.width > 0 && visibleRect.height > 0,
      );
      applyHighlight(nextRect);
      setTargetAvailable(isVisible);
      if (step === 1) setRecentHistoryAvailable(isVisible);
      if (step === 2) {
        setMapTargetAvailable(
          isVisible ||
            Boolean(document.querySelector('[data-tour="map-tile"]')),
        );
      }
      if (!anchorRect || !dialogRef.current) {
        setDialogPosition(null);
        return;
      }

      const dialogWidth = dialogRef.current.offsetWidth;
      const dialogHeight = dialogRef.current.offsetHeight;
      const clipToRadar = (rect: DOMRect) => {
        if (!radarViewport) return rect;
        const left = Math.max(rect.left, radarViewport.left);
        const top = Math.max(rect.top, radarViewport.top);
        const right = Math.min(rect.right, radarViewport.right);
        const bottom = Math.min(rect.bottom, radarViewport.bottom);
        return new DOMRect(
          left,
          top,
          Math.max(0, right - left),
          Math.max(0, bottom - top),
        );
      };
      // Protect the selected cluster, all visible throw points, trajectories
      // and the expanded stack throughout the radar practice steps.
      const radarDetails =
        radarViewport && step >= 9 && step <= 12
          ? [
              ...document.querySelectorAll(
                '.marker-layer [data-tour-action="cluster-click"], .marker-layer [data-tour-action="throw-stack"], .marker-layer [data-tour-action="throw-single"], .trajectory-screen-layer polyline, .trajectory-screen-layer line',
              ),
            ].map((marker) => clipToRadar(marker.getBoundingClientRect()))
          : [];
      const protectedRects = [
        nextRect,
        directRect,
        anchorRect,
        mapTriggerRect,
        mapMenuRect,
        openThrowStack?.getBoundingClientRect(),
        ...radarDetails,
        ...(step === 11
          ? [...document.querySelectorAll(target.selector)].map((spawn) =>
              clipToRadar(spawn.getBoundingClientRect()),
            )
          : []),
      ].filter((rect): rect is DOMRect =>
        Boolean(rect && rect.width && rect.height),
      );
      const inspectorRect =
        step >= 13 && step <= 20 && pathname.startsWith('/grenade/')
          ? document.querySelector('.detail-inspector')?.getBoundingClientRect()
          : null;
      const leftOfInspector =
        inspectorRect && inspectorRect.left >= dialogWidth + 32
          ? {
              left: Math.max(16, inspectorRect.left - dialogWidth - 16),
              top: Math.max(
                16,
                Math.min(
                  anchorRect.top + (anchorRect.height - dialogHeight) / 2,
                  window.innerHeight - dialogHeight - 16,
                ),
              ),
            }
          : null;
      const position =
        leftOfInspector ??
        placeTourDialog(
          anchorRect,
          inspectorRect ? [...protectedRects, inspectorRect] : protectedRects,
          radarViewport,
          dialogWidth,
          dialogHeight,
          window.innerWidth,
          window.innerHeight,
        );
      // During radar practice, keep the card outside the radar even while a
      // marker loads or moves off screen. Other steps retain the centered hint.
      if (!isVisible && !radarViewport) {
        setDialogPosition(null);
        return;
      }
      setDialogPosition((previous) =>
        previous?.left === position.left && previous.top === position.top
          ? previous
          : position,
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // A camera transition moves map markers without a resize or DOM mutation.
    let animationFrame = 0;
    const trackCamera = () => {
      if (
        document.querySelector('.map-camera.is-animating') ||
        (step === 11 && !selectedSpawn)
      )
        update();
      animationFrame = window.requestAnimationFrame(trackCamera);
    };
    if (step >= 8 && step <= 12) trackCamera();
    const observer = new MutationObserver(() => {
      const fresh = findTarget();
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
      highlightedTargets.forEach((element) =>
        element.classList.remove('onboarding-target-active'),
      );
      window.cancelAnimationFrame(animationFrame);
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
        className={`onboarding-dialog ${started && step === 0 ? 'onboarding-import-step' : ''} ${!targetAvailable && started && !(step >= 9 && step <= 12 && pathname.startsWith('/map/')) ? 'onboarding-centered' : ''} ${started && step >= 9 && step <= 12 && pathname.startsWith('/map/') ? 'onboarding-radar-step' : ''}`}
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
                        if (
                          index <= 2 &&
                          pathname !== '/maps' &&
                          pathname !== '/import'
                        ) {
                          // stay where we are, dialog will be centered with hint
                        }
                        if (
                          index >= 3 &&
                          index <= 10 &&
                          !pathname.startsWith('/map/') &&
                          activeImport
                        ) {
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
