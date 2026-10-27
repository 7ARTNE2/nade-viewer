import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
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
  Trash2,
  Timer,
  X,
} from 'lucide-react';
import c4Icon from '../assets/equipment_icons/c4.svg';
import flashbangAssistIcon from '../assets/equipment_icons/flashbang_assist.svg';
import defuserIcon from '../assets/equipment_icons/defuser.svg';
import armorIcon from '../assets/equipment_icons/armor.svg';
import armorHelmetIcon from '../assets/equipment_icons/armor_helmet.svg';
import ReplayCanvas from '../components/ReplayCanvas';
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
  return String(name ?? '').toLowerCase().replace(/[_-]/g, ' ');
}
function weaponMatchesActive(name: string, active?: string) {
  const weapon = normalizeWeapon(name);
  const current = normalizeWeapon(active);
  if (!weapon || !current) return false;
  return weapon === current || weapon.replace(/\s+/g, '') === current.replace(/\s+/g, '') ||
    (weapon.includes('m4a1') && current.includes('m4a1'));
}
function isFirearmWeapon(weapon: ReplayWeapon) {
  const name = normalizeWeapon(weapon.name);
  // Replay frames store the concrete equipment name in `type` (for example
  // "AK-47"), so classify from the name rather than expecting a class label.
  return /glock|usp|p2000|p250|deagle|desert eagle|five seven|tec 9|cz75|dual beretta|revolver|mp7|mp9|bizon|mac 10|ump|p90|mp5|sawed off|nova|mag 7|xm1014|m249|negev|galil|famas|ak 47|m4a4|m4a1|ssg 08|sg 553|aug|awp|scar 20|g3sg1/.test(name);
}
function weaponAmmoText(weapon: ReplayWeapon) {
  if (!isFirearmWeapon(weapon)) return '';
  const magazine = Number(weapon.ammo_in_magazine);
  const reserve = Number(weapon.ammo_reserve);
  if (!Number.isFinite(magazine) || !Number.isFinite(reserve) || magazine < 0 || reserve < 0) return '';
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
  if (/knife|bayonet|karambit|kukri|talon|butterfly|flip|gut|huntsman|falchion|shadow daggers|navaja|stiletto|ursus|nomad|paracord|survival/.test(name)) return 'knife';
  if (/glock|usp|p2000|p250|deagle|desert eagle|five seven|fiveseven|tec 9|cz75|dual beretta|elite|revolver|r8/.test(name)) return 'pistol';
  if (isFirearmWeapon(weapon)) return 'primary';
  return null;
}

function weaponSlots(weapons: ReplayWeapon[]) {
  const slots = new Map<WeaponSlot, ReplayWeapon>();
  for (const weapon of weapons) {
    const slot = weaponSlot(weapon);
    if (slot && !slots.has(slot)) slots.set(slot, weapon);
  }
  return (['primary', 'pistol', 'knife', 'zeus'] as WeaponSlot[])
    .flatMap((slot) => {
      const weapon = slots.get(slot);
      return weapon ? [{ slot, weapon }] : [];
    });
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
function killNotices(event: ReplayRound['events'][number]) {
  const data = event.data ?? {};
  const result: string[] = [];
  if (data.headshot === true) result.push('headshot');
  if (data.attacker_blind === true) result.push('blind');
  if (data.wallbang === true || Number(data.penetrated_objects ?? 0) > 0)
    result.push('penetrate');
  if (data.through_smoke === true) result.push('smoke');
  if (event.player_id && event.player_id === event.target_id)
    result.push('suicide');
  return result;
}
function roundReasonLabel(reason?: string | null, winnerSide?: string | null) {
  const value = String(reason ?? '').trim().toLowerCase();
  const labels: Record<string, string> = {
    target_saved: 'Target saved',
    bomb_defused: 'Bomb defused',
    bomb_exploded: 'Bomb exploded',
    terrorist_win: 'Terrorists win',
    ct_win: 'Counter-Terrorists win',
    time: 'Time expired',
  };
  return labels[value] ?? (winnerSide === 'T' ? 'Terrorists win' : winnerSide === 'CT' ? 'Counter-Terrorists win' : 'Round in progress');
}
function roundWinnerClass(side?: string | null) {
  return side === 'T' || side === 'CT' ? side.toLowerCase() : 'neutral';
}
function Team({ side, players, bombCarrier }: { side: string; players: ReplayPlayer[]; bombCarrier?: string }) {
  const { tr } = useI18n();
  const economy = players.reduce((sum, player) => sum + (player.equipment_value ?? 0), 0);
  const money = players.reduce((sum, player) => sum + player.money, 0);
  return (
    <section className={`replay-team is-${side.toLowerCase()}`}>
      <header>
        <strong>{players[0]?.team_name || side}</strong>
        <span className="replay-team-economy">${money.toLocaleString()} · ${economy.toLocaleString()}</span>
      </header>
      {players.map((p) => (
        <div className={`replay-player ${p.alive ? '' : 'is-dead'}`} key={p.id}>
          <div className="replay-player-head">
            <strong title={p.name}>{p.name}</strong>
            <span className="replay-player-stats">
              <b>{p.health} HP</b>
              <span className="replay-player-armor-inline" title={p.has_helmet ? 'Kevlar + helmet' : 'Kevlar'}>
                {p.armor > 0 && <img src={p.has_helmet ? armorHelmetIcon : armorIcon} alt="" />}
                {p.armor} AP
              </span>
              <span>${p.money.toLocaleString()}</span>
            </span>
          </div>
          <meter
            min={0}
            max={100}
            value={p.alive ? p.health : 0}
            aria-label={`${p.name} ${tr('health', 'здоровье')}`}
          />
          <div className="replay-player-loadout">
            <div className="replay-player-icons">
              <div className="replay-player-group replay-player-weapons">
              {weaponSlots(p.weapons ?? []).map(({ weapon: w }) => {
                const active = weaponMatchesActive(w.name, p.active_weapon);
                const ammo = weaponAmmoText(w);
                return (
                  <span className={`replay-player-item replay-player-weapon-item ${active ? 'active' : ''}`} key={w.name} title={ammo ? `${w.name} · ${ammo}` : w.name}>
                    <img src={weaponIcon(w.name)} alt="" />
                    {ammo && <small className="replay-player-ammo">{ammo}</small>}
                  </span>
                );
              })}
              </div>
              <div className="replay-player-group replay-player-grenades">
              {groupedGrenades(p.weapons ?? []).map(({ weapon, count }) => {
                const active = weaponMatchesActive(weapon.name, p.active_weapon);
                return (
                  <span className={`replay-player-item ${active ? 'active' : ''}`} key={normalizeWeapon(weapon.name)} title={`${weapon.name}${count > 1 ? ` ×${count}` : ''}`}>
                    <img src={weaponIcon(weapon.name)} alt="" />
                    {count > 1 && <small className="replay-player-count">×{count}</small>}
                  </span>
                );
              })}
              </div>
              <div className="replay-player-group replay-player-specials">
                {p.has_defuse_kit && <span className="replay-player-item" title={tr('Defuse kit', 'Дефьюз-кит')}><img src={defuserIcon} alt={tr('Defuse kit', 'Дефьюз-кит')} /></span>}
                {(p.id === bombCarrier || (p.weapons ?? []).some(isC4Weapon)) && <span className={`replay-player-item ${p.id === bombCarrier ? 'active' : ''}`} title={tr('Bomb', 'Бомба')}><img className="replay-player-c4" src={c4Icon} alt={tr('Bomb', 'Бомба')} /></span>}
              </div>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
export default function ReplayPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const id = routeId ? Number(routeId) : null;
  const navigate = useNavigate(),
    { tr, locale } = useI18n(),
    { showToast } = useToast();
  const [entries, setEntries] = useState<ReplayEntry[]>([]);
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const [round, setRound] = useState<ReplayRound | null>(null);
  const [number, setNumber] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [capability, setCapability] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showFreezeTime, setShowFreezeTime] = useState(true);
  const [autoNextRound, setAutoNextRound] = useState(false);
  const [replayOptionsOpen, setReplayOptionsOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [lower, setLower] = useState(false);
  const [selected, setSelected] = useState<ReplayGrenade | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [hoveredRound, setHoveredRound] = useState<number | null>(null);
  const [hoveredRoundRect, setHoveredRoundRect] = useState<{ left: number; top: number } | null>(null);
  const [roundPreviews, setRoundPreviews] = useState<Record<number, ReplayRound>>({});
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
  const showFreezeTimeRef = useRef(true);
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
  }, [autoNextRound]);
  useEffect(() => {
    showFreezeTimeRef.current = showFreezeTime;
  }, [showFreezeTime]);
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
    void getReplay(id).then(
      (v) => {
        if (!alive) return;
        setDetail(v);
        resume.current = v.tick;
        setNumber(
          v.rounds.some((r) => r.number === v.round_number)
            ? v.round_number
            : (v.rounds[0]?.number ?? null),
        );
      },
      (e) => {
        if (alive) fail(e);
      },
    );
    return () => {
      alive = false;
    };
  }, [id]);
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
        const index = detail.rounds.findIndex((r) => r.number === number);
        const keep = new Set(
          detail.rounds
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
  }, [detail, number]);
  useEffect(() => {
    const stop = onWindowActiveChange((active) => {
      if (!active) setPlaying(false);
    });
    return stop;
  }, []);
  useEffect(() => {
    if (!playing || !round || !detail) return;
    let raf = 0,
      last = 0,
      lastUi = 0;
    const [, end] = roundBounds(round);
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
        const currentIndex = detail.rounds.findIndex(
          (item) => item.number === round.round.number,
        );
        const nextRound = detail.rounds[currentIndex + 1];
        if (autoNextRound && nextRound) {
          setPlaying(false);
          autoPlayNextRound.current = true;
          autoNextTimer.current = window.setTimeout(() => {
            autoNextTimer.current = undefined;
            if (!autoNextRoundRef.current) {
              autoPlayNextRound.current = false;
              return;
            }
            changeRound(nextRound.number);
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
  }, [autoNextRound, playing, round, detail, speed]);
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
  const seek = (value: number) => {
    if (!round) return;
    const [a, b] = roundBounds(round);
    clock.current = clamp(value, a, b);
    setTick(clock.current);
  };
  useEffect(() => {
    if (!round || !detail) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(
          'input,textarea,select,button,a,[contenteditable=true]',
        )
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((v) => !v);
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const [a, b] = roundBounds(round);
        clock.current = clamp(
          clock.current +
            (e.code === 'ArrowRight' ? 5 : -5) * detail.metadata.tickrate,
          a,
          b,
        );
        setTick(clock.current);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [round, detail]);
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
  const changeRound = (next: number) => {
    window.clearTimeout(autoNextTimer.current);
    autoNextTimer.current = undefined;
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
    setPlaying(false);
    setNumber(next);
  };
  const frame = round ? framePair(round, tick)[0] : undefined;
  const players = round ? playersAt(round, tick, round.events, killTicks) : [];
  const bombCarrier = frame?.bomb?.state === 'carried' ? frame.bomb.carrier_id : '';
  const index = detail?.rounds.findIndex((r) => r.number === number) ?? -1;
  const bounds = round ? roundBounds(round) : [0, 1];
  const roundFinished = Boolean(round && tick >= bounds[1]);
  const score = (() => {
    const current = {
      t: round?.round.score_t ?? 0,
      ct: round?.round.score_ct ?? 0,
    };
    if (!roundFinished || !round || !detail) return current;
    const next = detail.rounds[index + 1];
    if (next) return { t: next.score_t, ct: next.score_ct };
    if (round.round.winner_side === 'T') current.t += 1;
    if (round.round.winner_side === 'CT') current.ct += 1;
    return current;
  })();
  const winnerSide = roundFinished ? round?.round.winner_side : '';
  const events = useMemo(
    () =>
      round?.events.filter((e) =>
        ['kill', 'bomb_planted', 'bomb_defused', 'bomb_exploded'].includes(
          e.type,
        ),
      ) ?? [],
    [round],
  );
  const killEvents = useMemo(
    () => round?.events.filter((event) => event.type === 'kill') ?? [],
    [round],
  );
  const damageEvents = useMemo(
    () => round?.events.filter((event) => event.type === 'damage') ?? [],
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
  const replayRounds = detail?.rounds.filter((item) => item.number > 0) ?? [];
  const loadRoundPreview = (roundNumber: number) => {
    if (!detail || roundNumber === number || roundPreviews[roundNumber]) return;
    let request = roundPreviewCache.current.get(roundNumber);
    if (!request) {
      request = getReplayRoundPreview(detail.id, roundNumber);
      roundPreviewCache.current.set(roundNumber, request);
    }
    void request.then((value) => {
      setRoundPreviews((current) => ({ ...current, [roundNumber]: value }));
    }).catch(() => {
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
      left: direction * Math.max(160, (roundRailRef.current.clientWidth || 320) * 0.7),
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
            <h1>{detail ? tr('Match replay', 'Повтор матча') : '2D Replay'}</h1>
            {detail && (
              <small
                className="replay-source-name"
                title={detail.metadata.demo_filename}
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
        <div className="replay-history">
          <div className="replay-section-title">
            <h2>{tr('Matches', 'Матчи')}</h2>
            <span className="replay-count">{entries.length}</span>
          </div>
          {!entries.length ? (
            <div className="replay-empty">
              <FolderOpen size={30} />
              <h2>{tr('No saved matches', 'Нет сохранённых матчей')}</h2>
              <span>
                {capability
                  ? tr('Select a .dem file', 'Выберите файл .dem')
                  : tr(
                      'Nade Parser with replay support is required',
                      'Нужен Nade Parser с поддержкой replay',
                    )}
              </span>
            </div>
          ) : (
            <div className="replay-match-list">
              {entries.map((entry) => (
                <article className="replay-match-row" key={entry.id}>
                  <Link
                    to={`/replays/${entry.id}`}
                    className="replay-match-open"
                  >
                    <span className="replay-map-code">
                      {entry.metadata.map.replace('de_', '')}
                    </span>
                    <div>
                      <strong>
                        {entry.metadata.team_t || 'T'} <span>vs</span>{' '}
                        {entry.metadata.team_ct || 'CT'}
                      </strong>
                      <small title={entry.metadata.demo_filename}>
                        {entry.metadata.demo_filename}
                      </small>
                    </div>
                    <div className="replay-match-meta">
                      <span>
                        {entry.metadata.round_count} {tr('rounds', 'раундов')}
                        {entry.metadata.incomplete
                          ? ' · ' + tr('Incomplete', 'Неполный')
                          : ''}
                      </span>
                      <small>
                        {new Date(entry.metadata.parsed_at).toLocaleDateString(
                          locale,
                        )}{' '}
                        · {(entry.size / 1048576).toFixed(1)} MB
                      </small>
                    </div>
                    <Play size={17} />
                  </Link>
                  <button
                    className="icon-btn"
                    aria-label={tr('Delete match', 'Удалить матч')}
                    data-tip={tr('Delete match', 'Удалить матч')}
                    onClick={() => setDeleting(entry)}
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : detail ? (
        <div className="replay-workspace">
          <div className="replay-round-bar">
            {detail.metadata.incomplete && (
              <span className="replay-incomplete">
                {tr('Incomplete demo', 'Неполное демо')}
              </span>
            )}
            {detail.map.has_lower_radar && (
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
            <div className="replay-round-rail" aria-label={tr('Round navigation', 'Навигация по раундам')}>
              <div className="replay-round-rail-track">
                <button type="button" className="replay-round-rail-arrow" disabled={!roundRailCanScrollPrev} onClick={() => scrollRoundRail(-1)} aria-label={tr('Previous rounds', 'Предыдущие раунды')}>
                  <ChevronLeft size={14} />
                </button>
                <div className="replay-round-rail-list" ref={roundRailRef}>
                  {replayRounds.map((item) => {
                    const winner = roundWinnerClass(item.winner_side);
                    return (
                      <button
                        key={item.number}
                        type="button"
                        className={`${item.number === number ? 'active' : ''} ${winner}`}
                        onClick={() => changeRound(item.number)}
                        onMouseEnter={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setHoveredRound(item.number);
                          setHoveredRoundRect({ left: rect.left + rect.width / 2, top: rect.top });
                          loadRoundPreview(item.number);
                        }}
                        onMouseLeave={() => setHoveredRound(null)}
                        onFocus={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setHoveredRound(item.number);
                          setHoveredRoundRect({ left: rect.left + rect.width / 2, top: rect.top });
                          loadRoundPreview(item.number);
                        }}
                        onBlur={() => setHoveredRound(null)}
                        aria-current={item.number === number ? 'true' : undefined}
                        aria-label={`${tr('Round', 'Раунд')} ${item.number}, ${item.score_t}:${item.score_ct}`}
                      >
                        <span>R{item.number}</span>
                        <strong>{item.score_t}:{item.score_ct}</strong>
                      </button>
                    );
                  })}
                </div>
                <button type="button" className="replay-round-rail-arrow" disabled={!roundRailCanScrollNext} onClick={() => scrollRoundRail(1)} aria-label={tr('Next rounds', 'Следующие раунды')}>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            <div className="replay-options replay-round-options">
              <button
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
                      setShowFreezeTime(next);
                      if (!next && round) {
                        seek(
                          round.round.freeze_end_tick ?? round.round.start_tick,
                        );
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
                    onClick={() => setAutoNextRound((value) => !value)}
                  >
                    <Repeat2 size={14} />
                    <span>{tr('Auto next round', 'Автоследующий раунд')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          {hoveredRound !== null && hoveredRoundRect && (() => {
            const preview = replayRounds.find((item) => item.number === hoveredRound);
            if (!preview) return null;
            const previewData = preview.number === number ? round : roundPreviews[preview.number];
            const previewEvents = previewData?.events.filter((event) =>
              ['kill', 'bomb_planted', 'bomb_defused', 'bomb_exploded'].includes(event.type),
            ) ?? [];
            const previewKillTicks = new Map<string, number>();
            for (const event of previewData?.events ?? []) {
              if (event.type !== 'kill' || !event.target_id) continue;
              const previous = previewKillTicks.get(event.target_id);
              if (previous === undefined || event.tick < previous) previewKillTicks.set(event.target_id, event.tick);
            }
            const previewEventTime = (value: number) => previewData && detail
              ? (() => {
                  const phase = roundPhaseTime(previewData.round, value, detail.metadata.tickrate);
                  return `${phase.freezing ? '-' : ''}${phase.label}`;
                })()
              : '';
            return (
              <div
                className="replay-round-rail-card"
                role="tooltip"
                style={{ left: hoveredRoundRect.left, top: hoveredRoundRect.top + 52 }}
              >
                <div className="replay-round-rail-card-head">
                  <span className="replay-round-rail-card-title">{tr('Round', 'Раунд')} {preview.number}</span>
                  <span className="replay-round-rail-card-score">{preview.score_t}:{preview.score_ct}</span>
                  {preview.winner_side && <span className={`replay-round-rail-card-winner ${roundWinnerClass(preview.winner_side)}`}>{preview.winner_side} {tr('win', 'победа')}</span>}
                </div>
                <div className="replay-round-rail-card-reason">{roundReasonLabel(preview.reason, preview.winner_side)}</div>
                <div className="replay-round-rail-card-feed">
                  {!previewData ? (
                    <span className="replay-round-rail-card-empty">{tr('Loading preview...', 'Загрузка превью...')}</span>
                  ) : previewEvents.length === 0 ? (
                    <span className="replay-round-rail-card-empty">{tr('No kills', 'Нет убийств')}</span>
                  ) : previewEvents.map((event, eventIndex) => {
                    if (event.type !== 'kill' || !previewData) {
                      return (
                        <span className="replay-round-rail-card-row" key={`${event.type}-${event.tick}-${eventIndex}`}>
                          <time>{previewEventTime(event.tick)}</time>
                          <span>{tr(event.type.replace(/_/g, ' '), event.type)}</span>
                        </span>
                      );
                    }
                    const eventPlayers = playersAt(previewData, event.tick, previewData.events, previewKillTicks);
                    const killer = eventPlayers.find((player) => player.id === event.player_id);
                    const victim = eventPlayers.find((player) => player.id === event.target_id);
                    const flashId = String(event.data?.flash_assister_id ?? '');
                    const assisterId = String(event.data?.assister_id ?? '');
                    const flashAssister = eventPlayers.find((player) => player.id === flashId);
                    const assister = eventPlayers.find((player) => player.id === assisterId);
                    const weapon = String(event.data?.weapon ?? '');
                    const notices = killNotices(event).map((id) => ({ id, icon: deathNoticeIcon(id) })).filter((item) => item.icon);
                    return (
                      <span className="replay-round-rail-card-row replay-round-rail-card-kill" key={`${event.type}-${event.tick}-${eventIndex}`}>
                        <time>{previewEventTime(event.tick)}</time>
                        <span className="replay-round-rail-card-kill-main">
                          <b className={`replay-killfeed-name ${String(killer?.side ?? 'world').toLowerCase()}`}>{killer?.name ?? event.player_id ?? 'World'}</b>
                          {event.data?.assisted_flash === true && flashAssister && <span className="replay-round-rail-card-assist flash"><img src={flashbangAssistIcon} alt="" />+{flashAssister.name}</span>}
                          {assister && <span className="replay-round-rail-card-assist">+{assister.name}</span>}
                          {weapon && <img className="replay-round-rail-card-weapon" src={weaponIcon(weapon)} alt="" />}
                          {notices.map((notice) => <img className="replay-round-rail-card-notice" key={notice.id} src={notice.icon} alt="" />)}
                          <b className={`replay-killfeed-name ${String(victim?.side ?? 'world').toLowerCase()}`}>{victim?.name ?? event.target_id ?? '—'}</b>
                        </span>
                      </span>
                    );
                  })}
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
                <ReplayCanvas
                  detail={detail}
                  round={round}
                  clock={clock}
                  tickrate={detail.metadata.tickrate}
                  lower={lower}
                  selected={selected}
                  copiedGrenadeId={copiedId}
                  onSelect={setSelected}
                  onCopyCoordinates={(grenade) => {
                    void copyGrenadeCoordinates(grenade);
                  }}

                  killfeed={
                    <div className="replay-killfeed" aria-label={tr('Kill feed', 'Киллчат')}>
                      {killEvents
                        .filter((event) => event.tick <= tick)
                        .slice(-2)
                        .map((event) => {
                          const weapon = String(event.data?.weapon ?? '');
                          const playersAtEvent = playersAt(round, event.tick, round.events, killTicks);
                          const killer = playersAtEvent.find((player) => player.id === event.player_id);
                          const victim = playersAtEvent.find((player) => player.id === event.target_id);
                          const assisterId = typeof event.data?.assister_id === 'string' || typeof event.data?.assister_id === 'number' ? String(event.data.assister_id) : '';
                          const assister = playersAtEvent.find((player) => player.id === assisterId);
                          const storedFlashAssisterId = typeof event.data?.flash_assister_id === 'string' || typeof event.data?.flash_assister_id === 'number' ? String(event.data.flash_assister_id) : '';
                          const flashAssister = playersAtEvent.find((player) => player.id === storedFlashAssisterId);
                          const isFlashAssist = event.data?.assisted_flash === true;
                          const damageAssistEvent = damageEvents
                            .filter((candidate) => candidate.target_id === event.target_id && candidate.player_id && candidate.player_id !== event.player_id && candidate.player_id !== storedFlashAssisterId && candidate.tick <= event.tick && candidate.tick >= event.tick - detail.metadata.tickrate * 5)
                            .sort((a, b) => b.tick - a.tick)[0];
                          const damageAssister = damageAssistEvent ? playersAtEvent.find((player) => player.id === damageAssistEvent.player_id) : undefined;
                          const flashAssisterId = storedFlashAssisterId || flashAssister?.id;
                          const damageAssisterId = damageAssister?.id;
                          const notices = killNotices(event).map((id) => ({ id, icon: deathNoticeIcon(id) })).filter((item) => item.icon);
                          return (
                            <div className="replay-killfeed-row" key={`${event.tick}-${event.target_id}`}>
                              <span className={`replay-killfeed-name ${String(killer?.side ?? 'world').toLowerCase()}`}>{killer?.name ?? event.player_id ?? 'World'}</span>
                              {assister && assister.id !== flashAssisterId && <span className={`replay-killfeed-assist damage ${String(assister.side).toLowerCase()}`}>+{assister.name}</span>}
                              {damageAssister && damageAssisterId !== assister?.id && damageAssisterId !== flashAssisterId && <span className={`replay-killfeed-assist damage ${String(damageAssister.side).toLowerCase()}`}>+{damageAssister.name}</span>}
                              {isFlashAssist && <span className={`replay-killfeed-assist flash ${String(flashAssister?.side ?? 'world').toLowerCase()}`} title={tr('Flash assist', 'Ассист флешкой')}><img className="replay-killfeed-assist-icon" src={flashbangAssistIcon} alt="" />{flashAssister ? `+${flashAssister.name}` : ''}</span>}
                              {weapon && <img src={weaponIcon(weapon)} alt={weapon} title={weapon} />}
                              {notices.map((item) => <img key={item.id} src={item.icon} alt={item.id} title={item.id} />)}
                              <span className={`replay-killfeed-name ${String(victim?.side ?? 'world').toLowerCase()}`}>{victim?.name ?? event.target_id ?? '—'}</span>
                            </div>
                          );
                        })}
                    </div>
                  }
                />
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
                            title={selected.data.thrower_team}
                          >
                            {selected.data.thrower_team}
                          </span>
                        )}
                      </div>
                      <div className="metric-grid replay-detail-metrics">
                        <div>
                          <Timer size={13} aria-hidden="true" />
                          <span title={tr('Airtime', 'Время полёта')}>
                            {tr('Airtime', 'Полёт')}
                          </span>
                          <strong>
                            {selected.data.airtime?.toFixed(3) ?? '—'} s
                          </strong>
                        </div>
                        <div>
                          <Clock size={13} aria-hidden="true" />
                          <span title={tr('Round time', 'Время раунда')}>
                            {tr('Round', 'Раунд')}
                          </span>
                          <strong>
                            {formatClock(selected.data.round_time_seconds)}
                          </strong>
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
                      <button
                        key={g.id}
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
                        <time>{grenadeTime(g)}</time>
                      </button>
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
                            : tr(
                                e.type.replace(/_/g, ' '),
                                (
                                  {
                                    bomb_planted: 'Бомба установлена',
                                    bomb_defused: 'Бомба обезврежена',
                                    bomb_exploded: 'Бомба взорвалась',
                                  } as Record<string, string>
                                )[e.type] || e.type,
                              )}
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
                    onClick={() => changeRound(detail.rounds[index - 1].number)}
                    aria-label={tr('Previous round', 'Предыдущий раунд')}
                    data-tip={tr('Previous round', 'Предыдущий раунд')}
                  >
                    <SkipBack size={18} />
                  </button>
                  <button
                    className="btn primary replay-play"
                    onClick={() => {
                      if (tick >= bounds[1]) seek(bounds[0]);
                      setPlaying((v) => !v);
                    }}
                    aria-label={
                      playing
                        ? tr('Pause', 'Пауза')
                        : tr('Play', 'Воспроизвести')
                    }
                    data-tip={
                      playing
                        ? tr('Pause', 'Пауза')
                        : tr('Play', 'Воспроизвести')
                    }
                  >
                    {playing ? <Pause size={20} /> : <Play size={20} />}
                  </button>
                  <button
                    className="icon-btn"
                    disabled={index < 0 || index >= detail.rounds.length - 1}
                    onClick={() => changeRound(detail.rounds[index + 1].number)}
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
                  onSeek={seek}
                  showFreezeTime={showFreezeTime}
                />
                <div
                  className="replay-speeds"
                  role="group"
                  aria-label={tr('Playback speed', 'Скорость воспроизведения')}
                >
                  {[0.25, 0.5, 1, 2, 4].map((value) => (
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
