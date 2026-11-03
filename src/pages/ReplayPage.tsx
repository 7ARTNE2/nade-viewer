import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  ArrowLeft,
  ArrowLeftRight,
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Menu,
  FolderOpen,
  Pause,
  Play,
  Repeat2,
  SkipBack,
  SkipForward,
  StickyNote,
  Timer,
  X,
} from 'lucide-react';
import c4Icon from '../assets/equipment_icons/c4.svg';
import ReplayKillAssists from '../components/ReplayKillAssists';
import defuserIcon from '../assets/equipment_icons/defuser.svg';
import armorIcon from '../assets/equipment_icons/armor.svg';
import armorHelmetIcon from '../assets/equipment_icons/armor_helmet.svg';
import ReplayCanvas from '../components/ReplayCanvas';
import { ReplayAnnotationsProvider } from '../components/ReplayAnnotations';
import ReplayKillfeed from '../components/ReplayKillfeed';
import ReplayHistory from '../components/ReplayHistory';
import {
  deleteReplayNotes,
  loadReplayNotes,
  useReplayNotes,
} from '../lib/replayNotes';
import ReplayTimeline from '../components/ReplayTimeline';
import ReplayClock from '../components/ReplayClock';
import DestructiveConfirmDialog from '../components/DestructiveConfirmDialog';
import GrenadeMapIcon from '../components/GrenadeMapIcon';
import ThrowKeyIcon from '../components/ThrowKeyIcon';
import { splitThrowKeys, throwKeyVisual } from '../lib/throwKeys';
import { formatClock } from '../lib/format';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';
import {
  deleteReplay,
  getReplay,
  getReplayCapability,
  getReplayRound,
  getReplayRoundPreview,
  listReplays,
  saveReplayPosition,
  startReplay,
} from '../lib/replay';
import {
  clamp,
  framePair,
  roundBounds,
  roundPhaseTime,
  replayTimers,
  playersAt,
} from '../lib/replayPlayback';
import { isWindowActive, onWindowActiveChange } from '../lib/windowActive';
import { weaponIcon } from '../lib/weaponIcons';
import { deathNoticeIcon } from '../lib/deathNoticeIcons';
import { killNotices } from '../lib/replayKillfeed';
import { preloadImage } from '../lib/imageCache';
import type {
  ReplayDetail,
  ReplayEntry,
  ReplayGrenade,
  ReplayPlayer,
  ReplayRound,
  ReplayWeapon,
} from '../types/replay';
import './ReplayPage.css';

type Job = {
  running: boolean;
  stage: string;
  completed: number;
  output: string | null;
  error: string | null;
};
function grenadeLabel(type: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    smoke: ['Smoke', 'Дым'],
    flash: ['Flash', 'Световая'],
    HE: ['HE', 'Осколочная'],
    molotov: ['Molotov', 'Молотов'],
    'incendiary grenade': ['Incendiary', 'Зажигательная'],
  };
  return labels[type]?.[locale === 'ru' ? 1 : 0] ?? type;
}
function normalizeWeapon(name?: string) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[_-]/g, ' ');
}
function weaponMatchesActive(name: string, active?: string) {
  const weapon = normalizeWeapon(name);
  const current = normalizeWeapon(active);
  if (!weapon || !current) return false;
  return (
    weapon === current ||
    weapon.replace(/\s+/g, '') === current.replace(/\s+/g, '') ||
    (weapon.includes('m4a1') && current.includes('m4a1'))
  );
}
function isFirearmWeapon(weapon: ReplayWeapon) {
  const name = normalizeWeapon(weapon.name);
  // Replay frames store the concrete equipment name in `type` (for example
  // "AK-47"), so classify from the name rather than expecting a class label.
  return /glock|usp|p2000|p250|deagle|desert eagle|five seven|tec 9|cz75|dual beretta|revolver|mp7|mp9|bizon|mac 10|ump|p90|mp5|sawed off|nova|mag 7|xm1014|m249|negev|galil|famas|ak 47|m4a4|m4a1|ssg 08|sg 553|aug|awp|scar 20|g3sg1/.test(
    name,
  );
}
function weaponAmmoText(weapon: ReplayWeapon) {
  if (!isFirearmWeapon(weapon)) return '';
  const magazine = Number(weapon.ammo_in_magazine);
  const reserve = Number(weapon.ammo_reserve);
  if (
    !Number.isFinite(magazine) ||
    !Number.isFinite(reserve) ||
    magazine < 0 ||
    reserve < 0
  )
    return '';
  if (magazine === 0 && reserve === 0) return '';
  return `${magazine}/${reserve}`;
}
function isC4Weapon(weapon: ReplayWeapon) {
  const value = `${normalizeWeapon(weapon.name)} ${normalizeWeapon(weapon.type)}`;
  return value.includes('c4') || value.includes('bomb');
}
function isGrenadeWeapon(weapon: ReplayWeapon) {
  const value = `${normalizeWeapon(weapon.name)} ${normalizeWeapon(weapon.type)}`;
  return /grenade|flashbang|smoke|molotov|incendiary|decoy/.test(value);
}
type WeaponSlot = 'primary' | 'pistol' | 'knife' | 'zeus';

function weaponSlot(weapon: ReplayWeapon): WeaponSlot | null {
  const name = `${normalizeWeapon(weapon.name)} ${normalizeWeapon(weapon.type)}`;
  if (isC4Weapon(weapon) || isGrenadeWeapon(weapon)) return null;
  if (/zeus|taser/.test(name)) return 'zeus';
  if (
    /knife|bayonet|karambit|kukri|talon|butterfly|flip|gut|huntsman|falchion|shadow daggers|navaja|stiletto|ursus|nomad|paracord|survival/.test(
      name,
    )
  )
    return 'knife';
  if (
    /glock|usp|p2000|p250|deagle|desert eagle|five seven|fiveseven|tec 9|cz75|dual beretta|elite|revolver|r8/.test(
      name,
    )
  )
    return 'pistol';
  if (isFirearmWeapon(weapon)) return 'primary';
  return null;
}

function weaponSlots(weapons: ReplayWeapon[]) {
  const slots = new Map<WeaponSlot, ReplayWeapon>();
  for (const weapon of weapons) {
    const slot = weaponSlot(weapon);
    if (slot && !slots.has(slot)) slots.set(slot, weapon);
  }
  return (['primary', 'pistol', 'knife', 'zeus'] as WeaponSlot[]).flatMap(
    (slot) => {
      const weapon = slots.get(slot);
      return weapon ? [{ slot, weapon }] : [];
    },
  );
}
function groupedGrenades(weapons: ReplayWeapon[]) {
  const groups = new Map<string, { weapon: ReplayWeapon; count: number }>();
  for (const weapon of weapons) {
    if (!isGrenadeWeapon(weapon)) continue;
    const key = normalizeWeapon(weapon.name) || normalizeWeapon(weapon.type);
    if (!key) continue;
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { weapon, count: 1 });
  }
  return [...groups.values()].slice(0, 5);
}
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];
function roundReasonLabel(
  reason: string | null | undefined,
  winnerSide: string | null | undefined,
  tr: (english: string, russian: string) => string,
) {
  const value = String(reason ?? '')
    .trim()
    .toLowerCase();
  const labels: Record<string, [string, string]> = {
    target_saved: ['Target saved', 'Цель сохранена'],
    bomb_defused: ['Bomb defused', 'Бомба обезврежена'],
    bomb_exploded: ['Bomb exploded', 'Бомба взорвалась'],
    target_bombed: ['Bomb exploded', 'Бомба взорвалась'],
    terrorist_win: ['Terrorists win', 'Победа террористов'],
    t_win: ['Terrorists win', 'Победа террористов'],
    ct_win: ['Counter-Terrorists win', 'Победа спецназа'],
    time: ['Time expired', 'Время истекло'],
    draw: ['Draw', 'Ничья'],
    t_surrender: ['Terrorists surrendered', 'Террористы сдались'],
    ct_surrender: ['Counter-Terrorists surrendered', 'Спецназ сдался'],
    t_planted: ['Bomb planted', 'Бомба установлена'],
  };
  const label =
    labels[value] ??
    (winnerSide === 'T'
      ? labels.t_win
      : winnerSide === 'CT'
        ? labels.ct_win
        : ['Round in progress', 'Раунд продолжается']);
  return tr(label[0], label[1]);
}
function roundWinnerClass(side?: string | null) {
  return side === 'T' || side === 'CT' ? side.toLowerCase() : 'neutral';
}
function roundEndingScore(round: {
  score_t: number;
  score_ct: number;
  winner_side?: string | null;
}) {
  return {
    t: round.score_t + (round.winner_side === 'T' ? 1 : 0),
    ct: round.score_ct + (round.winner_side === 'CT' ? 1 : 0),
  };
}
const Team = memo(
  function Team({
    side,
    players,
    bombCarrier,
  }: {
    side: string;
    players: ReplayPlayer[];
    bombCarrier?: string;
  }) {
    const { tr } = useI18n();
    const economy = players.reduce(
      (sum, player) => sum + (player.equipment_value ?? 0),
      0,
    );
    const money = players.reduce((sum, player) => sum + player.money, 0);
    return (
      <section className={`replay-team is-${side.toLowerCase()}`}>
        <header>
          <div className="replay-team-heading">
            <strong>{players[0]?.team_name || side}</strong>
            <span
              className="replay-team-economy"
              data-tip={tr(
                'Money / Equipment value',
                'Деньги / Стоимость экипировки',
              )}
            >
              ${money.toLocaleString()} · ${economy.toLocaleString()}
            </span>
          </div>
          <span
            className="replay-team-kda-heading"
            data-tip={tr(
              'Kills / Deaths / Assists',
              'Убийства / Смерти / Ассисты',
            )}
            aria-label={tr(
              'Kills / Deaths / Assists',
              'Убийства / Смерти / Ассисты',
            )}
          >
            <span>K</span>
            <span>D</span>
            <span>A</span>
          </span>
        </header>
        {players.map((p) => (
          <div
            className={`replay-player ${p.alive ? '' : 'is-dead'}`}
            key={p.id}
          >
            <div className="replay-player-head">
              <strong data-tip={p.name}>{p.name}</strong>
              <span
                className="replay-player-kda"
                aria-label={`${tr('Kills', 'Убийства')}: ${p.kills ?? 0}, ${tr('Deaths', 'Смерти')}: ${p.deaths ?? 0}, ${tr('Assists', 'Ассисты')}: ${p.assists ?? 0}`}
                data-tip={tr(
                  'Kills / Deaths / Assists',
                  'Убийства / Смерти / Ассисты',
                )}
              >
                <b>{p.kills ?? 0}</b>
                <b>{p.deaths ?? 0}</b>
                <b>{p.assists ?? 0}</b>
              </span>
            </div>
            <div className="replay-player-stats">
              <b>{p.health} HP</b>
              <meter
                min={0}
                max={100}
                value={p.alive ? p.health : 0}
                aria-label={`${p.name} ${tr('health', 'здоровье')}`}
              />
              <span
                className="replay-player-armor-inline"
                data-tip={
                  p.has_helmet
                    ? tr('Kevlar + helmet', 'Броня + шлем')
                    : tr('Kevlar', 'Броня')
                }
              >
                {p.armor > 0 && (
                  <img
                    src={p.has_helmet ? armorHelmetIcon : armorIcon}
                    alt=""
                  />
                )}
                {p.armor} AP
              </span>
              <span>${p.money.toLocaleString()}</span>
            </div>
            <div className="replay-player-loadout">
              <div className="replay-player-icons">
                <div className="replay-player-group replay-player-weapons">
                  {weaponSlots(p.weapons ?? []).map(({ slot, weapon: w }) => {
                    const active = weaponMatchesActive(w.name, p.active_weapon);
                    const ammo = weaponAmmoText(w);
                    return (
                      <span
                        className={`replay-player-item replay-player-weapon-item ${active ? 'active' : ''}`}
                        data-slot={slot}
                        key={w.name}
                        data-tip={ammo ? `${w.name} · ${ammo}` : w.name}
                      >
                        <img src={weaponIcon(w.name)} alt="" />
                        {ammo && (
                          <small className="replay-player-ammo">{ammo}</small>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="replay-player-group replay-player-grenades">
                  {groupedGrenades(p.weapons ?? []).map(({ weapon, count }) => {
                    const active = weaponMatchesActive(
                      weapon.name,
                      p.active_weapon,
                    );
                    return (
                      <span
                        className={`replay-player-item ${active ? 'active' : ''}`}
                        key={normalizeWeapon(weapon.name)}
                        data-tip={`${weapon.name}${count > 1 ? ` ×${count}` : ''}`}
                      >
                        <img src={weaponIcon(weapon.name)} alt="" />
                        {count > 1 && (
                          <small className="replay-player-count">
                            ×{count}
                          </small>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="replay-player-group replay-player-specials">
                  {p.has_defuse_kit && (
                    <span
                      className="replay-player-item"
                      data-tip={tr('Defuse kit', 'Дефьюз-кит')}
                    >
                      <img
                        src={defuserIcon}
                        alt={tr('Defuse kit', 'Дефьюз-кит')}
                      />
                    </span>
                  )}
                  {(p.id === bombCarrier ||
                    (p.weapons ?? []).some(isC4Weapon)) && (
                    <span
                      className={`replay-player-item ${p.id === bombCarrier ? 'active' : ''}`}
                      data-tip={tr('Bomb', 'Бомба')}
                    >
                      <img
                        className="replay-player-c4"
                        src={c4Icon}
                        alt={tr('Bomb', 'Бомба')}
                      />
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </section>
    );
  },
  (previous, next) => {
    if (
      previous.side !== next.side ||
      previous.bombCarrier !== next.bombCarrier ||
      previous.players.length !== next.players.length
    ) {
      return false;
    }
    return previous.players.every((player, index) => {
      const nextPlayer = next.players[index];
      return (
        nextPlayer &&
        player.id === nextPlayer.id &&
        player.alive === nextPlayer.alive &&
        player.health === nextPlayer.health &&
        player.armor === nextPlayer.armor &&
        player.money === nextPlayer.money &&
        player.kills === nextPlayer.kills &&
        player.deaths === nextPlayer.deaths &&
        player.assists === nextPlayer.assists &&
        player.active_weapon === nextPlayer.active_weapon &&
        player.weapons === nextPlayer.weapons
      );
    });
  },
);
export default function ReplayPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const id = routeId ? Number(routeId) : null;
  const [searchParams] = useSearchParams();
  const requestedNoteId = searchParams.get('note');
  const navigate = useNavigate(),
    { tr, locale } = useI18n(),
    { showToast } = useToast();
  const [entries, setEntries] = useState<ReplayEntry[]>([]);
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const dualRadar =
    detail?.map.name.toLowerCase().replace(/^de_/, '') === 'nuke';
  const replayNotes = useReplayNotes(detail);
  const [round, setRound] = useState<ReplayRound | null>(null);
  const [number, setNumber] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [capability, setCapability] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showFreezeTime, setShowFreezeTime] = useState(false);
  const [autoNextRound, setAutoNextRound] = useState(false);
  const [replayOptionsOpen, setReplayOptionsOpen] = useState(false);
  const replayOptionsRef = useRef<HTMLDivElement>(null);
  const replayOptionsTrigger = useRef<HTMLButtonElement>(null);
  const [tick, setTick] = useState(0);
  const [lower, setLower] = useState(false);
  const [notesControlsTarget, setNotesControlsTarget] =
    useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<ReplayGrenade | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [hoveredRound, setHoveredRound] = useState<number | null>(null);
  const roundPreviewCloseTimer = useRef<number>();
  const keepRoundPreviewOpen = useCallback(() => {
    window.clearTimeout(roundPreviewCloseTimer.current);
  }, []);
  const closeRoundPreview = useCallback(() => {
    window.clearTimeout(roundPreviewCloseTimer.current);
    roundPreviewCloseTimer.current = window.setTimeout(
      () => setHoveredRound(null),
      180,
    );
  }, []);
  useEffect(
    () => () => window.clearTimeout(roundPreviewCloseTimer.current),
    [],
  );
  const [hoveredRoundRect, setHoveredRoundRect] = useState<{
    left: number;
    top: number;
    align: 'start' | 'center' | 'end';
  } | null>(null);
  const [roundPreviews, setRoundPreviews] = useState<
    Record<number, ReplayRound>
  >({});
  const [timelineZoomTarget, setTimelineZoomTarget] =
    useState<HTMLDivElement | null>(null);
  const roundRailRef = useRef<HTMLDivElement | null>(null);
  const roundPreviewCache = useRef(new Map<number, Promise<ReplayRound>>());
  const [roundRailCanScrollPrev, setRoundRailCanScrollPrev] = useState(false);
  const [roundRailCanScrollNext, setRoundRailCanScrollNext] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<number>();
  const copyRequest = useRef(0);
  useEffect(() => {
    setCopiedId(null);
    return () => {
      copyRequest.current++;
      window.clearTimeout(copyTimer.current);
    };
  }, [selected?.id]);
  const [deleting, setDeleting] = useState<ReplayEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const clock = useRef(0),
    resume = useRef<number | null>(null);
  const autoNextRoundRef = useRef(false);
  const autoPlayNextRound = useRef(false);
  const autoNextTimer = useRef<number>();
  const cancelAutoNext = useCallback(() => {
    window.clearTimeout(autoNextTimer.current);
    autoNextTimer.current = undefined;
    autoPlayNextRound.current = false;
  }, []);
  const showFreezeTimeRef = useRef(false);
  const replayRounds = useMemo(
    () => detail?.rounds.filter((item) => item.number > 0) ?? [],
    [detail],
  );
  const killTicks = useMemo(() => {
    const ticks = new Map<string, number>();
    if (!round) return ticks;
    for (const event of round.events) {
      if (event.type !== 'kill' || !event.target_id) continue;
      const previous = ticks.get(event.target_id);
      if (previous === undefined || event.tick < previous)
        ticks.set(event.target_id, event.tick);
    }
    return ticks;
  }, [round]);
  useEffect(() => {
    autoNextRoundRef.current = autoNextRound;
    if (!autoNextRound) cancelAutoNext();
  }, [autoNextRound, cancelAutoNext]);
  useEffect(() => {
    showFreezeTimeRef.current = showFreezeTime;
  }, [showFreezeTime]);
  useEffect(() => {
    if (!replayOptionsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !replayOptionsRef.current?.contains(event.target)
      ) {
        setReplayOptionsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setReplayOptionsOpen(false);
      replayOptionsTrigger.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [replayOptionsOpen]);
  const cache = useRef(new Map<number, Promise<ReplayRound>>());
  const loadedRounds = useRef(new Map<number, ReplayRound>());
  const jobOwned = useRef(false),
    lastCompleted = useRef<string | null>(null);
  const position = useRef<{ id: number; number: number; tick: number } | null>(
    null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fail = (e: unknown) => setError(String(e));
  useEffect(() => {
    let alive = true;
    void listReplays().then(
      (v) => {
        if (alive) setEntries(v);
      },
      (e) => {
        if (alive) fail(e);
      },
    );
    void getReplayCapability().then(
      (v) => {
        if (alive) setCapability(v);
      },
      (e) => {
        if (alive) fail(e);
      },
    );
    const poll = async () => {
      try {
        const status = await invoke<Job>('get_nade_parser_status');
        if (!alive) return;
        setJob(status);
        if (status.running && status.stage === 'replay')
          jobOwned.current = true;
        if (
          !status.running &&
          status.output?.startsWith('replay:') &&
          lastCompleted.current !== status.output
        ) {
          lastCompleted.current = status.output;
          const list = await listReplays();
          if (!alive) return;
          setEntries(list);
          if (jobOwned.current) {
            jobOwned.current = false;
            navigate('/replays/' + status.output.slice(7));
          }
        }
        if (!status.running && status.error && jobOwned.current) {
          jobOwned.current = false;
          setError(status.error);
        }
      } catch (e) {
        if (alive) fail(e);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 800);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [navigate]);
  useEffect(() => {
    let alive = true;
    cancelAutoNext();
    setReplayOptionsOpen(false);
    setPlaying(false);
    setDetail(null);
    setRound(null);
    setNumber(null);
    setSelected(null);
    setRoundPreviews({});
    roundPreviewCache.current.clear();
    setError('');
    cache.current = new Map();
    loadedRounds.current = new Map();
    resume.current = null;
    const previous = position.current;
    if (previous)
      void saveReplayPosition(
        previous.id,
        previous.number,
        previous.tick,
      ).catch(() => undefined);
    position.current = null;
    if (id === null) return;
    void Promise.all([getReplay(id), loadReplayNotes(id).catch(() => [])]).then(
      ([v, notes]) => {
        if (!alive) return;
        setDetail(v);
        const note = notes.find(
          (item) =>
            item.id === requestedNoteId &&
            v.rounds.some((r) => r.number === item.round),
        );
        resume.current = note?.tick ?? v.tick;
        if (note) {
          setShowFreezeTime(true);
          setLower(note.lower);
        }
        setNumber(
          note
            ? note.round
            : v.rounds.some((r) => r.number > 0 && r.number === v.round_number)
              ? v.round_number
              : (v.rounds.find((r) => r.number > 0)?.number ?? null),
        );
      },
      (e) => {
        if (alive) fail(e);
      },
    );
    return () => {
      alive = false;
      cancelAutoNext();
    };
  }, [id, cancelAutoNext, requestedNoteId]);
  useEffect(() => {
    if (!detail) return;
    void Promise.allSettled([
      preloadImage(detail.map.map_image_path),
      preloadImage(detail.map.lower_map_image_path),
    ]);
  }, [detail]);
  useEffect(() => {
    if (!detail || number === null) return;
    let alive = true;
    const cachedRound = loadedRounds.current.get(number);
    if (!cachedRound) setRound(null);
    setSelected(null);
    setPlaying(false);
    const load = (n: number) => {
      let request = cache.current.get(n);
      if (!request) {
        request = getReplayRound(detail.id, n);
        cache.current.set(n, request);
      }
      return request.then((value) => {
        loadedRounds.current.set(n, value);
        return value;
      });
    };
    if (cachedRound) {
      // The next round is commonly prefetched. Put it on screen immediately
      // while the promise below still refreshes the normal loading path.
      const [cachedStart, cachedEnd] = roundBounds(cachedRound);
      const cachedPlaybackStart = showFreezeTimeRef.current
        ? cachedStart
        : (cachedRound.round.freeze_end_tick ?? cachedStart);
      clock.current = clamp(cachedPlaybackStart, cachedStart, cachedEnd);
      setTick(clock.current);
      setRound(cachedRound);
    }
    void load(number).then(
      (v) => {
        if (!alive) return;
        const [a, b] = roundBounds(v);
        const playbackStart = showFreezeTimeRef.current
          ? a
          : (v.round.freeze_end_tick ?? a);
        const next = clamp(
          Math.max(resume.current ?? playbackStart, playbackStart),
          a,
          b,
        );
        const continuePlaying =
          autoPlayNextRound.current && autoNextRoundRef.current;
        autoPlayNextRound.current = false;
        resume.current = null;
        clock.current = next;
        setTick(next);
        setRound(v);
        if (continuePlaying) setPlaying(true);
        const index = replayRounds.findIndex((r) => r.number === number);
        const keep = new Set(
          replayRounds
            .slice(Math.max(0, index - 1), index + 2)
            .map((r) => r.number),
        );
        for (const n of cache.current.keys())
          if (!keep.has(n)) {
            cache.current.delete(n);
            loadedRounds.current.delete(n);
          }
        for (const n of keep)
          if (n !== number) void load(n).catch(() => cache.current.delete(n));
      },
      (e) => {
        if (alive) {
          cache.current.delete(number);
          fail(e);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [detail, number, replayRounds]);
  const changeRound = useCallback(
    (next: number, autoplay = false) => {
      if (!replayRounds.some((item) => item.number === next)) return;
      cancelAutoNext();
      autoPlayNextRound.current = autoplay;
      resume.current = null;
      const p = position.current;
      if (p)
        void saveReplayPosition(p.id, p.number, clock.current).catch(
          () => undefined,
        );
      const cached = loadedRounds.current.get(next);
      if (cached) {
        const [a, b] = roundBounds(cached);
        const start = showFreezeTimeRef.current
          ? a
          : (cached.round.freeze_end_tick ?? a);
        clock.current = clamp(start, a, b);
        setTick(clock.current);
        setRound(cached);
      }
      setSelected(null);
      setPlaying(false);
      setNumber(next);
    },
    [cancelAutoNext, replayRounds],
  );
  useEffect(() => {
    const stop = onWindowActiveChange((active) => {
      if (!active) {
        cancelAutoNext();
        setPlaying(false);
      }
    });
    return stop;
  }, [cancelAutoNext]);
  useEffect(() => {
    if (!playing || !round || !detail) return;
    let raf = 0,
      last = 0,
      lastUi = 0;
    const [start, end] = roundBounds(round);
    const playbackStart = showFreezeTimeRef.current
      ? start
      : (round.round.freeze_end_tick ?? start);
    if (clock.current < playbackStart) {
      clock.current = clamp(playbackStart, start, end);
      setTick(clock.current);
    }
    const run = (now: number) => {
      if (!isWindowActive()) {
        setPlaying(false);
        return;
      }
      if (last)
        clock.current = Math.min(
          end,
          clock.current +
            ((now - last) / 1000) * detail.metadata.tickrate * speed,
        );
      last = now;
      if (now - lastUi > 80 || clock.current >= end) {
        setTick(clock.current);
        lastUi = now;
      }
      if (clock.current >= end) {
        const currentIndex = replayRounds.findIndex(
          (item) => item.number === round.round.number,
        );
        const nextRound = replayRounds[currentIndex + 1];
        if (autoNextRound && nextRound) {
          setPlaying(false);
          autoNextTimer.current = window.setTimeout(() => {
            autoNextTimer.current = undefined;
            if (!autoNextRoundRef.current || !isWindowActive()) {
              autoPlayNextRound.current = false;
              return;
            }
            changeRound(nextRound.number, true);
          }, 650);
          return;
        }
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [autoNextRound, playing, round, detail, speed, replayRounds, changeRound]);
  useEffect(() => {
    if (id === null || !round) return;
    position.current = { id, number: round.round.number, tick };
  }, [id, round, tick]);
  useEffect(() => {
    const save = () => {
      const p = position.current;
      if (p)
        void saveReplayPosition(p.id, p.number, p.tick).catch(() => undefined);
    };
    const timer = window.setInterval(save, 2000);
    return () => {
      window.clearInterval(timer);
      save();
    };
  }, []);
  const seek = useCallback(
    (value: number, includeFreezeTime = false) => {
      cancelAutoNext();
      if (!round) return;
      const [a, b] = roundBounds(round);
      if (includeFreezeTime && value < (round.round.freeze_end_tick ?? a))
        setShowFreezeTime(true);
      const start =
        showFreezeTime || includeFreezeTime
          ? a
          : clamp(round.round.freeze_end_tick ?? a, a, b);
      clock.current = clamp(value, start, b);
      setTick(clock.current);
    },
    [cancelAutoNext, round, showFreezeTime],
  );
  const togglePlayback = useCallback(() => {
    if (!round) return;
    cancelAutoNext();
    const [start, end] = roundBounds(round);
    if (!playing && clock.current >= end) seek(start);
    setPlaying((value) => !value);
  }, [cancelAutoNext, playing, round, seek]);
  useEffect(() => {
    if (!round || !detail) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        e.shiftKey ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"]',
        ) ||
        (e.target instanceof Element &&
          e.target.closest(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="combobox"],[role="listbox"],[role="spinbutton"],.replay-round-rail-card',
          ))
      )
        return;
      if (e.code === 'Space') {
        if (e.target instanceof Element && e.target.closest('button,a')) return;
        e.preventDefault();
        if (!e.repeat) togglePlayback();
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        seek(
          clock.current +
            (e.code === 'ArrowRight' ? 5 : -5) * detail.metadata.tickrate,
        );
      }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        setSpeed(
          (value) =>
            REPLAY_SPEEDS[
              clamp(
                REPLAY_SPEEDS.indexOf(value) + (e.code === 'ArrowUp' ? 1 : -1),
                0,
                REPLAY_SPEEDS.length - 1,
              )
            ],
        );
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [round, detail, seek, togglePlayback]);
  const open = async () => {
    setStarting(true);
    setError('');
    try {
      const files = await invoke<string[]>('select_demo_files');
      if (files[0]) {
        lastCompleted.current = null;
        await startReplay(files[0]);
        jobOwned.current = true;
        setJob({
          running: true,
          stage: 'replay',
          completed: 0,
          output: null,
          error: null,
        });
      }
    } catch (e) {
      fail(e);
    } finally {
      if (mounted.current) setStarting(false);
    }
  };
  const copyGrenadeCoordinates = async (grenade: ReplayGrenade) => {
    if (!grenade.data.coordinates) return;
    const request = ++copyRequest.current;
    try {
      await navigator.clipboard.writeText(grenade.data.coordinates);
      if (request !== copyRequest.current) return;
      setCopiedId(grenade.id);
      copyButton.current?.getAnimations().forEach((animation) => {
        animation.currentTime = 0;
      });
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1600);
      showToast(tr('Coordinates copied', 'Координаты скопированы'), {
        tone: 'success',
      });
    } catch (e) {
      if (request === copyRequest.current) fail(e);
    }
  };
  const copy = () => {
    if (selected) void copyGrenadeCoordinates(selected);
  };
  const frame = round ? framePair(round, tick)[0] : undefined;
  const players = round ? playersAt(round, tick, round.events, killTicks) : [];
  const bombCarrier =
    frame?.bomb?.state === 'carried' ? frame.bomb.carrier_id : '';
  const index = replayRounds.findIndex((r) => r.number === number);
  const bounds = round ? roundBounds(round) : [0, 1];
  const roundFinished = Boolean(round && tick >= bounds[1]);
  const currentScore = round
    ? {
        t: round.round.score_t,
        ct: round.round.score_ct,
      }
    : { t: 0, ct: 0 };
  const finishedScore = round ? roundEndingScore(round.round) : currentScore;
  const score = roundFinished ? finishedScore : currentScore;
  const winnerSide = roundFinished ? (round?.round.winner_side ?? '') : '';
  const events = useMemo(
    () =>
      round?.events.filter((e) =>
        ['kill', 'bomb_planted', 'bomb_defused', 'bomb_exploded'].includes(
          e.type,
        ),
      ) ?? [],
    [round],
  );
  const eventTime = (value: number) => {
    if (!round || !detail) return '';
    const phase = roundPhaseTime(round.round, value, detail.metadata.tickrate);
    return `${phase.freezing ? '-' : ''}${phase.label}`;
  };
  const grenadeTime = (grenade: ReplayGrenade) => {
    if (!round || !detail) return '-';
    const timers = replayTimers(
      round,
      grenade.release_tick,
      detail.metadata.tickrate,
    );
    return timers.bomb?.time ?? formatClock(grenade.data.round_time_seconds);
  };
  const grenadeHasBombTimer = (grenade: ReplayGrenade) =>
    round?.events.some(
      (event) =>
        event.type === 'bomb_planted' && event.tick <= grenade.release_tick,
    ) ?? false;
  const replayEventLabel = (type: string) => {
    const labels: Record<string, [string, string]> = {
      bomb_planted: ['Bomb planted', 'Бомба установлена'],
      bomb_defused: ['Bomb defused', 'Бомба обезврежена'],
      bomb_exploded: ['Bomb exploded', 'Бомба взорвалась'],
    };
    const label = labels[type];
    return label ? tr(label[0], label[1]) : type.replace(/_/g, ' ');
  };
  const grenadeTrajectoryTick = (grenade: ReplayGrenade) => {
    if (!round || !detail?.radar) return grenade.release_tick;
    let previous: { x: number; y: number } | null = null;
    for (const frame of round.frames) {
      const projectile = frame.projectiles?.find((p) => p.id === grenade.id);
      if (!projectile) continue;
      if (
        previous &&
        Math.hypot(projectile.x - previous.x, projectile.y - previous.y) >=
          1.5 * detail.radar.scale
      ) {
        return frame.tick;
      }
      previous = { x: projectile.x, y: projectile.y };
    }
    return grenade.release_tick;
  };
  const replayEndScores = useMemo(() => {
    const scores: Record<number, { t: number; ct: number }> = {};
    for (const item of replayRounds) {
      scores[item.number] = roundEndingScore(item);
    }
    return scores;
  }, [replayRounds]);
  const loadRoundPreview = (roundNumber: number) => {
    if (!detail || roundNumber === number || roundPreviews[roundNumber]) return;
    let request = roundPreviewCache.current.get(roundNumber);
    if (!request) {
      request = getReplayRoundPreview(detail.id, roundNumber);
      roundPreviewCache.current.set(roundNumber, request);
    }
    void request
      .then((value) => {
        setRoundPreviews((current) => ({ ...current, [roundNumber]: value }));
      })
      .catch(() => {
        roundPreviewCache.current.delete(roundNumber);
      });
  };
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    const rounds = detail.rounds
      .filter((item) => item.number > 0 && item.number !== number)
      .map((item) => item.number);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(3, rounds.length) },
      async () => {
        while (!cancelled) {
          const roundNumber = rounds[cursor++];
          if (roundNumber === undefined) return;
          if (roundPreviewCache.current.has(roundNumber)) continue;
          const request = getReplayRoundPreview(detail.id, roundNumber);
          roundPreviewCache.current.set(roundNumber, request);
          try {
            const value = await request;
            if (!cancelled) {
              setRoundPreviews((current) =>
                current[roundNumber]
                  ? current
                  : { ...current, [roundNumber]: value },
              );
            }
          } catch {
            roundPreviewCache.current.delete(roundNumber);
          }
        }
      },
    );
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [detail, number]);
  const scrollRoundRail = (direction: -1 | 1) => {
    roundRailRef.current?.scrollBy({
      left:
        direction *
        Math.max(160, (roundRailRef.current.clientWidth || 320) * 0.7),
      behavior: 'smooth',
    });
  };
  useEffect(() => {
    const node = roundRailRef.current;
    if (!node) return;
    const update = () => {
      const max = node.scrollWidth - node.clientWidth;
      setRoundRailCanScrollPrev(node.scrollLeft > 1);
      setRoundRailCanScrollNext(max > 1 && node.scrollLeft < max - 1);
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      node.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [detail?.rounds.length]);
  return (
    <div className="replay-page">
      <header className="replay-header">
        <div className="replay-heading">
          {id !== null && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                const p = position.current;
                if (p)
                  void saveReplayPosition(p.id, p.number, clock.current).catch(
                    () => undefined,
                  );
                navigate('/replays');
              }}
              aria-label={tr('Replay history', 'История матчей')}
              data-tip={tr('Replay history', 'История матчей')}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div>
            <span className="replay-eyebrow">
              {detail ? detail.metadata.map : 'NADE VIEWER'}
            </span>
            <h1>
              {detail
                ? tr('Match replay', 'Повтор матча')
                : tr('Replay', 'Повторы')}
            </h1>
            {detail && (
              <small
                className="replay-source-name"
                data-tip={detail.metadata.demo_filename}
              >
                {detail.metadata.demo_filename}
              </small>
            )}
          </div>
        </div>
        {detail && (
          <div className="replay-match-score">
            <span
              className={`replay-side-t ${winnerSide === 'T' ? 'is-winner' : ''}`}
            >
              {frame?.players.find((p) => p.side === 'T')?.team_name ||
                detail.metadata.team_t ||
                'T'}
              {winnerSide === 'T' && <em>{tr('Winner', 'Победа')}</em>}
            </span>
            <strong className="replay-score-value">{score.t}</strong>
            {round && (
              <ReplayClock
                round={round}
                tick={tick}
                tickrate={detail.metadata.tickrate}
              />
            )}
            <strong className="replay-score-value">{score.ct}</strong>
            <span
              className={`replay-side-ct ${winnerSide === 'CT' ? 'is-winner' : ''}`}
            >
              {frame?.players.find((p) => p.side === 'CT')?.team_name ||
                detail.metadata.team_ct ||
                'CT'}
              {winnerSide === 'CT' && <em>{tr('Winner', 'Победа')}</em>}
            </span>
          </div>
        )}
        <div className="replay-header-actions">
          {!capability && (
            <Link className="btn" to="/tools/nade-parser">
              {tr('Update Nade Parser', 'Обновить Nade Parser')}
            </Link>
          )}
          {id === null && (
            <button
              className="btn primary"
              disabled={!capability || starting || job?.running}
              onClick={() => void open()}
            >
              <FolderOpen size={16} />
              {tr('Open demo', 'Открыть демо')}
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="replay-error" role="alert">
          <span>{error}</span>
          <button
            className="icon-btn"
            onClick={() => setError('')}
            aria-label={tr('Dismiss', 'Закрыть')}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {job?.running && (
        <div className="replay-progress" role="status">
          <span className="spinner" />
          <span>
            {job.stage === 'replay'
              ? tr('Parsing match', 'Разбор матча')
              : tr('Nade Parser is busy', 'Nade Parser занят')}{' '}
            · {job.completed} {tr('rounds', 'раундов')}
          </span>
          <button
            className="icon-btn"
            aria-label={tr('Cancel parsing', 'Отменить разбор')}
            onClick={() => void invoke('stop_nade_parser').catch(fail)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {id === null ? (
        <ReplayHistory
          entries={entries}
          capability={capability}
          onDelete={setDeleting}
        />
      ) : detail ? (
        <div className="replay-workspace">
          <div className="replay-round-bar">
            {detail.metadata.incomplete && (
              <span className="replay-incomplete">
                {tr('Incomplete demo', 'Неполное демо')}
              </span>
            )}
            {detail.map.has_lower_radar && !dualRadar && (
              <div
                className="radar-switch replay-segment"
                role="group"
                aria-label={tr('Radar level', 'Этаж')}
              >
                <button
                  className={!lower ? 'active' : ''}
                  aria-pressed={!lower}
                  onClick={() => setLower(false)}
                >
                  <span className="radar-switch-indicator" />
                  {tr('Upper', 'Верх')}
                </button>
                <button
                  className={lower ? 'active' : ''}
                  aria-pressed={lower}
                  onClick={() => setLower(true)}
                >
                  <span className="radar-switch-indicator" />
                  {tr('Lower', 'Низ')}
                </button>
              </div>
            )}
            <div
              className="replay-round-rail"
              aria-label={tr('Round navigation', 'Навигация по раундам')}
            >
              <div className="replay-round-rail-track">
                <button
                  type="button"
                  className="replay-round-rail-arrow"
                  disabled={!roundRailCanScrollPrev}
                  onClick={() => scrollRoundRail(-1)}
                  aria-label={tr('Previous rounds', 'Предыдущие раунды')}
                >
                  <ChevronLeft size={14} />
                </button>
                <div className="replay-round-rail-list" ref={roundRailRef}>
                  {replayRounds.map((item, index) => {
                    const noteCount = replayNotes.filter(
                      (note) => note.round === item.number,
                    ).length;
                    const winner = roundWinnerClass(item.winner_side);
                    const endingScore = replayEndScores[item.number] ?? {
                      t: item.score_t,
                      ct: item.score_ct,
                    };
                    // Scores are recorded at round start, before its winner is added.
                    const playedBefore = item.score_t + item.score_ct;
                    const sideSwitch =
                      index > 0 &&
                      (playedBefore === 12 ||
                        (playedBefore >= 24 && (playedBefore - 24) % 3 === 0));
                    const switchTitle =
                      playedBefore === 12
                        ? tr('Side switch (halftime)', 'Смена сторон (перерыв)')
                        : tr('Overtime side switch', 'Смена сторон (допы)');
                    return (
                      <Fragment key={item.number}>
                        {sideSwitch && (
                          <div
                            className="replay-round-rail-switch"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={switchTitle}
                            data-tip={switchTitle}
                          >
                            <ArrowLeftRight size={12} aria-hidden="true" />
                          </div>
                        )}
                        <button
                          type="button"
                          className={`${item.number === number ? 'active' : ''} ${winner}`}
                          onClick={() => changeRound(item.number)}
                          onMouseEnter={(event) => {
                            keepRoundPreviewOpen();
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setHoveredRound(item.number);
                            const first =
                              item.number === replayRounds[0]?.number;
                            const last =
                              item.number ===
                              replayRounds[replayRounds.length - 1]?.number;
                            setHoveredRoundRect({
                              left: first
                                ? rect.left
                                : last
                                  ? rect.right
                                  : rect.left + rect.width / 2,
                              top: rect.top,
                              align: first ? 'start' : last ? 'end' : 'center',
                            });
                            loadRoundPreview(item.number);
                          }}
                          onMouseLeave={closeRoundPreview}
                          onFocus={(event) => {
                            keepRoundPreviewOpen();
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setHoveredRound(item.number);
                            const first =
                              item.number === replayRounds[0]?.number;
                            const last =
                              item.number ===
                              replayRounds[replayRounds.length - 1]?.number;
                            setHoveredRoundRect({
                              left: first
                                ? rect.left
                                : last
                                  ? rect.right
                                  : rect.left + rect.width / 2,
                              top: rect.top,
                              align: first ? 'start' : last ? 'end' : 'center',
                            });
                            loadRoundPreview(item.number);
                          }}
                          onBlur={closeRoundPreview}
                          aria-current={
                            item.number === number ? 'true' : undefined
                          }
                          aria-label={`${tr('Round', 'Раунд')} ${item.number}, ${endingScore.t}:${endingScore.ct}${noteCount ? `, ${tr('Notes', 'Заметки')}: ${noteCount}` : ''}`}
                        >
                          <span>R{item.number}</span>
                          {noteCount > 0 && (
                            <StickyNote
                              className="replay-round-note-badge"
                              size={10}
                              aria-hidden="true"
                              data-tip={`${tr('Notes', 'Заметки')}: ${noteCount}`}
                            />
                          )}
                          <strong>
                            {endingScore.t}:{endingScore.ct}
                          </strong>
                        </button>
                      </Fragment>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="replay-round-rail-arrow"
                  disabled={!roundRailCanScrollNext}
                  onClick={() => scrollRoundRail(1)}
                  aria-label={tr('Next rounds', 'Следующие раунды')}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            <div
              ref={replayOptionsRef}
              className="replay-options replay-round-options"
            >
              <button
                ref={replayOptionsTrigger}
                type="button"
                className="icon-btn replay-options-trigger"
                aria-haspopup="menu"
                aria-expanded={replayOptionsOpen}
                onClick={() => setReplayOptionsOpen((value) => !value)}
                aria-label={tr('Replay settings', 'Настройки реплея')}
                data-tip={tr('Replay settings', 'Настройки реплея')}
              >
                <Menu size={17} />
              </button>
              {replayOptionsOpen && (
                <div className="replay-options-menu" role="menu">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={showFreezeTime}
                    className={`replay-timeline-toggle ${showFreezeTime ? 'is-active' : ''}`}
                    onClick={() => {
                      const next = !showFreezeTime;
                      cancelAutoNext();
                      setShowFreezeTime(next);
                      if (!next && round) {
                        const [start, end] = roundBounds(round);
                        const actionStart =
                          round.round.freeze_end_tick ?? start;
                        if (clock.current < actionStart) {
                          clock.current = clamp(actionStart, start, end);
                          setTick(clock.current);
                        }
                      }
                    }}
                  >
                    {showFreezeTime ? <Eye size={14} /> : <EyeOff size={14} />}
                    <span>{tr('Freeze time', 'Фризтайм')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={autoNextRound}
                    className={`replay-timeline-toggle ${autoNextRound ? 'is-active' : ''}`}
                    onClick={() => {
                      cancelAutoNext();
                      setAutoNextRound((value) => !value);
                    }}
                  >
                    <Repeat2 size={14} />
                    <span>{tr('Auto next round', 'Автоследующий раунд')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          {hoveredRound !== null &&
            hoveredRoundRect &&
            (() => {
              const preview = replayRounds.find(
                (item) => item.number === hoveredRound,
              );
              if (!preview) return null;
              const previewScore = replayEndScores[preview.number] ?? {
                t: preview.score_t,
                ct: preview.score_ct,
              };
              const previewData =
                preview.number === number
                  ? round
                  : roundPreviews[preview.number];
              const actionStart =
                previewData?.round.freeze_end_tick ?? preview.start_tick;
              const previewRoundEvents =
                previewData?.events.filter(
                  (event) =>
                    event.tick >= actionStart &&
                    event.tick <= (previewData.round.end_tick ?? Infinity),
                ) ?? [];
              const previewDamageEvents = previewRoundEvents.filter(
                (event) => event.type === 'damage',
              );
              const previewEvents = previewRoundEvents.filter((event) =>
                [
                  'kill',
                  'bomb_planted',
                  'bomb_defused',
                  'bomb_exploded',
                ].includes(event.type),
              );
              const previewKillTicks = new Map<string, number>();
              for (const event of previewRoundEvents) {
                if (event.type !== 'kill' || !event.target_id) continue;
                const previous = previewKillTicks.get(event.target_id);
                if (previous === undefined || event.tick < previous)
                  previewKillTicks.set(event.target_id, event.tick);
              }
              const previewEventTime = (value: number) =>
                previewData && detail
                  ? (() => {
                      const phase = roundPhaseTime(
                        previewData.round,
                        value,
                        detail.metadata.tickrate,
                      );
                      return `${phase.freezing ? '-' : ''}${phase.label}`;
                    })()
                  : '';
              return (
                <div
                  className={`replay-round-rail-card is-${hoveredRoundRect.align}`}
                  role="tooltip"
                  onMouseEnter={keepRoundPreviewOpen}
                  onMouseLeave={closeRoundPreview}
                  onFocus={keepRoundPreviewOpen}
                  onBlur={closeRoundPreview}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      keepRoundPreviewOpen();
                      setHoveredRound(null);
                    }
                  }}
                  style={{
                    left: hoveredRoundRect.left,
                    top: hoveredRoundRect.top + 52,
                    maxHeight: `calc(100dvh - ${hoveredRoundRect.top + 64}px)`,
                  }}
                >
                  <div className="replay-round-rail-card-head">
                    <span className="replay-round-rail-card-title">
                      {tr('Round', 'Раунд')} {preview.number}
                    </span>
                    <span className="replay-round-rail-card-score">
                      {previewScore.t}:{previewScore.ct}
                    </span>
                    {preview.winner_side && (
                      <span
                        className={`replay-round-rail-card-winner ${roundWinnerClass(preview.winner_side)}`}
                      >
                        {preview.winner_side} {tr('win', 'победа')}
                      </span>
                    )}
                  </div>
                  <div className="replay-round-rail-card-reason">
                    {roundReasonLabel(preview.reason, preview.winner_side, tr)}
                  </div>
                  <div
                    className="replay-round-rail-card-feed"
                    tabIndex={0}
                    role="region"
                    aria-label={tr('Round events', 'События раунда')}
                  >
                    {!previewData ? (
                      <span className="replay-round-rail-card-empty">
                        {tr('Loading preview...', 'Загрузка превью...')}
                      </span>
                    ) : previewEvents.length === 0 ? (
                      <span className="replay-round-rail-card-empty">
                        {tr('No kills', 'Нет убийств')}
                      </span>
                    ) : (
                      previewEvents.map((event, eventIndex) => {
                        if (event.type !== 'kill' || !previewData) {
                          return (
                            <span
                              className="replay-round-rail-card-row"
                              key={`${event.type}-${event.tick}-${eventIndex}`}
                            >
                              <time>{previewEventTime(event.tick)}</time>
                              <span>{replayEventLabel(event.type)}</span>
                            </span>
                          );
                        }
                        const eventPlayers = playersAt(
                          previewData,
                          event.tick,
                          previewData.events,
                          previewKillTicks,
                        );
                        const killer = eventPlayers.find(
                          (player) => player.id === event.player_id,
                        );
                        const victim = eventPlayers.find(
                          (player) => player.id === event.target_id,
                        );
                        const weapon = String(event.data?.weapon ?? '');
                        const notices = killNotices(event)
                          .map((id) => ({ id, icon: deathNoticeIcon(id) }))
                          .filter((item) => item.icon);
                        return (
                          <span
                            className="replay-round-rail-card-row replay-round-rail-card-kill"
                            key={`${event.type}-${event.tick}-${eventIndex}`}
                          >
                            <time>{previewEventTime(event.tick)}</time>
                            <span className="replay-round-rail-card-kill-main">
                              <b
                                className={`replay-killfeed-name ${String(killer?.side ?? 'world').toLowerCase()}`}
                              >
                                {killer?.name ?? event.player_id ?? 'World'}
                              </b>
                              <ReplayKillAssists
                                event={event}
                                players={eventPlayers}
                                events={previewDamageEvents}
                                tickrate={detail.metadata.tickrate}
                                className="replay-round-rail-card-assist"
                              />
                              {weapon && (
                                <img
                                  className="replay-round-rail-card-weapon"
                                  src={weaponIcon(weapon)}
                                  alt=""
                                />
                              )}
                              {notices.map((notice) => (
                                <img
                                  className="replay-round-rail-card-notice"
                                  key={notice.id}
                                  src={notice.icon}
                                  alt=""
                                />
                              ))}
                              <b
                                className={`replay-killfeed-name ${String(victim?.side ?? 'world').toLowerCase()}`}
                              >
                                {victim?.name ?? event.target_id ?? '—'}
                              </b>
                            </span>
                          </span>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })()}
          {round ? (
            <>
              <div className="replay-stage">
                <aside className="replay-rosters">
                  <Team
                    side="T"
                    players={players.filter((p) => p.side === 'T')}
                    bombCarrier={bombCarrier}
                  />
                  <Team
                    side="CT"
                    players={players.filter((p) => p.side === 'CT')}
                    bombCarrier={bombCarrier}
                  />
                </aside>
                <ReplayAnnotationsProvider
                  key={`${detail.id}.${detail.metadata.parsed_at}`}
                >
                  <div
                    ref={setNotesControlsTarget}
                    className={`replay-radars ${dualRadar ? 'is-dual' : ''}`}
                  >
                    {(dualRadar ? [false, true] : [lower]).map((floor) => (
                      <section
                        className="replay-radar-pane"
                        key={dualRadar ? String(floor) : 'single'}
                        aria-label={
                          floor
                            ? tr('Lower radar', 'Нижний радар')
                            : tr('Main radar', 'Основной радар')
                        }
                        data-floor={floor ? 'lower' : 'main'}
                      >
                        {dualRadar && (
                          <div className="replay-radar-label">
                            {floor
                              ? tr('Lower', 'Нижний')
                              : tr('Main', 'Основной')}
                          </div>
                        )}
                        <ReplayCanvas
                          key={`${detail.id}.${detail.metadata.parsed_at}`}
                          detail={detail}
                          round={round}
                          clock={clock}
                          tickrate={detail.metadata.tickrate}
                          lower={floor}
                          showNotesControls={!dualRadar || !floor}
                          notesControlsTarget={
                            dualRadar ? notesControlsTarget : null
                          }
                          selected={selected}
                          onPause={() => {
                            cancelAutoNext();
                            setPlaying(false);
                          }}
                          onSeekNote={(noteTick, noteLower) => {
                            setLower(noteLower);
                            seek(noteTick, true);
                          }}
                          copiedGrenadeId={copiedId}
                          onSelect={(grenade) => {
                            cancelAutoNext();
                            setSelected(grenade);
                          }}
                          onCopyCoordinates={(grenade) => {
                            void copyGrenadeCoordinates(grenade);
                          }}
                        />
                      </section>
                    ))}
                    <ReplayKillfeed
                      key={`${detail.id}.${round.round_number}`}
                      round={round}
                      clock={clock}
                      tick={tick}
                      tickrate={detail.metadata.tickrate}
                      playing={playing}
                    />
                  </div>
                </ReplayAnnotationsProvider>
                <aside className="replay-inspector">
                  {selected ? (
                    <section className="replay-grenade-detail">
                      <header>
                        <h2 className="replay-detail-type">
                          <span
                            className={`replay-nade-icon type-${selected.data.grenade_type.toLowerCase().replace(/ /g, '-')}`}
                          >
                            <GrenadeMapIcon
                              grenadeType={selected.data.grenade_type}
                            />
                          </span>
                          {grenadeLabel(selected.data.grenade_type, locale)}
                        </h2>
                        <button
                          className="icon-btn"
                          aria-label={tr('Close grenade', 'Закрыть гранату')}
                          data-tip={tr('Close grenade', 'Закрыть гранату')}
                          onClick={() => setSelected(null)}
                        >
                          <X size={14} />
                        </button>
                      </header>
                      <div className="detail-title-row replay-detail-player">
                        <span
                          className={`side-mini side-${selected.data.side.toLowerCase()}`}
                        >
                          {selected.data.side}
                        </span>
                        <strong>{selected.data.thrower}</strong>
                        {selected.data.thrower_team && (
                          <span
                            className={`detail-thrower-team side-accent-${selected.data.side.toLowerCase()}`}
                            data-tip={selected.data.thrower_team}
                          >
                            {selected.data.thrower_team}
                          </span>
                        )}
                      </div>
                      <div className="metric-grid replay-detail-metrics">
                        <div>
                          <Timer size={13} aria-hidden="true" />
                          <span data-tip={tr('Airtime', 'Время полёта')}>
                            {tr('Airtime', 'Полёт')}
                          </span>
                          <strong>
                            {selected.data.airtime?.toFixed(3) ?? '—'} s
                          </strong>
                        </div>
                        <div>
                          <Clock size={13} aria-hidden="true" />
                          <span
                            data-tip={
                              grenadeHasBombTimer(selected)
                                ? tr(
                                    'Bomb timer at throw',
                                    'Таймер бомбы при броске',
                                  )
                                : tr('Round time', 'Время раунда')
                            }
                          >
                            {grenadeHasBombTimer(selected)
                              ? tr('Bomb', 'Бомба')
                              : tr('Round', 'Раунд')}
                          </span>
                          <strong>{grenadeTime(selected)}</strong>
                        </div>
                      </div>
                      <div className="info-block replay-detail-keys">
                        <div className="block-title">
                          {tr('Throw keys', 'Клавиши броска')}
                        </div>
                        {selected.data.throw_keys ? (
                          <div className="throw-preview-keys detail-throw-keys">
                            {splitThrowKeys(selected.data.throw_keys).map(
                              (key, keyIndex) => {
                                const visual = throwKeyVisual(key);
                                return (
                                  <span
                                    className="throw-preview-key-part"
                                    key={`${key}-${keyIndex}`}
                                  >
                                    <span
                                      className={`throw-preview-key-icon ${visual.kind} ${visual.iconOnly ? 'icon-only' : ''}`}
                                      data-tip={visual.title}
                                    >
                                      {visual.iconOnly ? (
                                        visual.kind === 'mouse' ? (
                                          <>
                                            <span>{visual.label}</span>
                                            <ThrowKeyIcon
                                              glyph={visual.glyph}
                                            />
                                          </>
                                        ) : (
                                          <ThrowKeyIcon glyph={visual.glyph} />
                                        )
                                      ) : (
                                        <span>{visual.label}</span>
                                      )}
                                    </span>
                                  </span>
                                );
                              },
                            )}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                      <div className="info-block replay-detail-coordinates">
                        <div className="block-title">
                          {tr('Coordinates', 'Координаты')}
                          <button
                            ref={copyButton}
                            type="button"
                            className={`micro-btn detail-copy-button ${copiedId === selected.id ? 'copied' : ''}`}
                            disabled={!selected.data.coordinates}
                            onClick={() => void copy()}
                            aria-label={tr(
                              'Copy coordinates',
                              'Копировать координаты',
                            )}
                            data-tip={
                              copiedId === selected.id
                                ? tr('Copied', 'Скопировано')
                                : tr(
                                    'Copy coordinates',
                                    'Копировать координаты',
                                  )
                            }
                          >
                            {copiedId === selected.id ? (
                              <Check className="copy-action-icon" size={13} />
                            ) : (
                              <Copy className="copy-action-icon" size={13} />
                            )}
                          </button>
                        </div>
                        <div className="coordinate-command-panel">
                          <code>{selected.data.coordinates || '—'}</code>
                        </div>
                      </div>
                      <div className="replay-detail-actions">
                        <button
                          className="btn"
                          onClick={() => {
                            seek(selected.release_tick);
                            setPlaying(false);
                          }}
                        >
                          <SkipBack size={14} />
                          {tr('Go to throw', 'К броску')}
                        </button>
                      </div>
                    </section>
                  ) : null}
                  <section className="replay-throws">
                    <h2>
                      <span>
                        <Crosshair size={13} />
                        {tr('Grenades', 'Гранаты')}
                      </span>
                      <small className="replay-count">
                        {round.grenades.length}
                      </small>
                    </h2>
                    {round.grenades.map((g) => (
                      <div className="replay-throw-row" key={g.id}>
                        <button
                          className={`replay-throw ${selected?.id === g.id ? 'active' : ''}`}
                          onClick={() => {
                            setSelected(g);
                            seek(grenadeTrajectoryTick(g));
                            setPlaying(false);
                          }}
                        >
                          <span
                            className={`replay-nade-icon type-${g.data.grenade_type.toLowerCase().replace(/ /g, '-')}`}
                          >
                            <GrenadeMapIcon grenadeType={g.data.grenade_type} />
                          </span>
                          <span>
                            <strong>{g.data.thrower}</strong>
                            <small>
                              {grenadeLabel(g.data.grenade_type, locale)}
                            </small>
                          </span>
                          <time
                            data-tip={
                              grenadeHasBombTimer(g)
                                ? tr(
                                    'Bomb timer at throw',
                                    'Таймер бомбы при броске',
                                  )
                                : tr('Round time', 'Время раунда')
                            }
                          >
                            {grenadeTime(g)}
                          </time>
                        </button>
                        <button
                          type="button"
                          className={`copy-action replay-throw-copy ${copiedId === g.id ? 'copied' : ''}`}
                          onClick={() => void copyGrenadeCoordinates(g)}
                          disabled={!g.data.coordinates}
                          aria-label={tr(
                            'Copy grenade coordinates',
                            'Копировать координаты гранаты',
                          )}
                          data-tip={
                            copiedId === g.id
                              ? tr('Copied', 'Скопировано')
                              : tr('Copy coordinates', 'Копировать координаты')
                          }
                        >
                          {copiedId === g.id ? (
                            <Check className="copy-action-icon" size={13} />
                          ) : (
                            <Copy className="copy-action-icon" size={13} />
                          )}
                          <span className="sr-only">
                            {copiedId === g.id
                              ? tr('Copied', 'Скопировано')
                              : tr('Copy', 'Копировать')}
                          </span>
                        </button>
                      </div>
                    ))}
                  </section>
                  <section className="replay-events">
                    <h2>
                      <span>
                        <Activity size={13} />
                        {tr('Events', 'События')}
                      </span>
                      <small className="replay-count">{events.length}</small>
                    </h2>
                    {!events.length && (
                      <p className="replay-list-empty">
                        {tr('No events', 'Нет событий')}
                      </p>
                    )}
                    {events.map((e, i) => (
                      <button
                        key={i}
                        className={e.tick <= tick ? 'is-past' : ''}
                        onClick={() => {
                          seek(e.tick);
                          setPlaying(false);
                        }}
                      >
                        <time>{eventTime(e.tick)}</time>
                        <span>
                          {e.type === 'kill'
                            ? e.message
                            : replayEventLabel(e.type)}
                        </span>
                      </button>
                    ))}
                  </section>
                </aside>
              </div>
              <footer className="replay-controls">
                <div className="replay-transport">
                  <button
                    className="icon-btn"
                    disabled={index <= 0}
                    onClick={() => changeRound(replayRounds[index - 1].number)}
                    aria-label={tr('Previous round', 'Предыдущий раунд')}
                    data-tip={tr('Previous round', 'Предыдущий раунд')}
                  >
                    <SkipBack size={18} />
                  </button>
                  <button
                    className="btn primary replay-play"
                    onClick={togglePlayback}
                    aria-label={
                      playing
                        ? tr('Pause', 'Пауза')
                        : tr('Play', 'Воспроизвести')
                    }
                    data-tip={
                      playing
                        ? tr('Pause · Space', 'Пауза · Пробел')
                        : tr('Play · Space', 'Воспроизвести · Пробел')
                    }
                  >
                    {playing ? <Pause size={20} /> : <Play size={20} />}
                  </button>
                  <button
                    className="icon-btn"
                    disabled={index < 0 || index >= replayRounds.length - 1}
                    onClick={() => changeRound(replayRounds[index + 1].number)}
                    aria-label={tr('Next round', 'Следующий раунд')}
                    data-tip={tr('Next round', 'Следующий раунд')}
                  >
                    <SkipForward size={18} />
                  </button>
                </div>
                <ReplayTimeline
                  round={round}
                  clock={clock}
                  tick={tick}
                  tickrate={detail.metadata.tickrate}
                  playing={playing}
                  events={events}
                  grenades={round.grenades}
                  grenadeTick={grenadeTrajectoryTick}
                  onGrenadeSelect={(grenade) => {
                    setSelected(grenade);
                    seek(grenadeTrajectoryTick(grenade));
                    setPlaying(false);
                  }}
                  zoomPortalTarget={timelineZoomTarget}
                  onSeek={seek}
                  showFreezeTime={showFreezeTime}
                />
                <div className="replay-speed-stack">
                  <div
                    ref={setTimelineZoomTarget}
                    className="replay-zoom-slot"
                  />
                  <div
                    className="replay-speeds"
                    data-tip={tr(
                      '↑ / ↓ Speed · ← / → Seek 5 seconds and pause',
                      '↑ / ↓ Скорость · ← / → Перемотка на 5 секунд и пауза',
                    )}
                    role="group"
                    aria-label={tr(
                      'Playback speed',
                      'Скорость воспроизведения',
                    )}
                  >
                    {REPLAY_SPEEDS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={`${value}×`}
                        aria-pressed={speed === value}
                        onClick={() => setSpeed(value)}
                      >
                        <span>
                          {value}
                          <small>×</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </footer>
            </>
          ) : (
            <div className="replay-empty" role="status">
              <span className="spinner" />
              {tr('Loading round', 'Загрузка раунда')}
            </div>
          )}
        </div>
      ) : (
        <div className="replay-empty" role="status">
          {!error && (
            <>
              <span className="spinner" />
              {tr('Loading match', 'Загрузка матча')}
            </>
          )}
        </div>
      )}
      {deleting && (
        <DestructiveConfirmDialog
          eyebrow={tr('Replay history', 'История матчей')}
          title={tr('Delete match?', 'Удалить матч?')}
          description={tr(
            'Saved replay data will be deleted.',
            'Сохранённые данные повтора будут удалены.',
          )}
          metadata={<span>{deleting.metadata.demo_filename}</span>}
          confirmLabel={tr('Delete', 'Удалить')}
          pendingLabel={tr('Deleting', 'Удаление')}
          busy={deleteBusy}
          error=""
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeleteBusy(true);
            void deleteReplay(deleting.id)
              .then(() => {
                try {
                  deleteReplayNotes(deleting);
                } catch {
                  /* The match has already been deleted. */
                }
                setEntries((old) => old.filter((e) => e.id !== deleting.id));
                setDeleting(null);
              }, fail)
              .finally(() => setDeleteBusy(false));
          }}
        />
      )}
    </div>
  );
}
