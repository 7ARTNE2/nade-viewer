import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Activity,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Ellipsis,
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
import type {
  ReplayDetail,
  ReplayEntry,
  ReplayGrenade,
  ReplayPlayer,
  ReplayRound,
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
function Team({ side, players }: { side: string; players: ReplayPlayer[] }) {
  const { tr } = useI18n();
  return (
    <section className={`replay-team is-${side.toLowerCase()}`}>
      <header>
        <strong>{players[0]?.team_name || side}</strong>
        <span>
          {players.filter((p) => p.alive).length} / {players.length}
        </span>
      </header>
      {players.map((p) => (
        <div className={`replay-player ${p.alive ? '' : 'is-dead'}`} key={p.id}>
          <div>
            <strong title={p.name}>{p.name}</strong>
            <span>{p.health} HP</span>
          </div>
          <meter
            min={0}
            max={100}
            value={p.alive ? p.health : 0}
            aria-label={`${p.name} ${tr('health', 'здоровье')}`}
          />
          <div>
            <small title={p.active_weapon}>{p.active_weapon || '—'}</small>
            <small>{p.armor} AP</small>
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
  const events =
    round?.events.filter((e) =>
      ['kill', 'bomb_planted', 'bomb_defused', 'bomb_exploded'].includes(
        e.type,
      ),
    ) ?? [];
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
            <div className="replay-round-select">
              <select
                aria-label={tr('Round', 'Раунд')}
                value={number ?? ''}
                onChange={(event) => changeRound(Number(event.target.value))}
              >
                {detail.rounds.map((r) => (
                  <option key={r.number} value={r.number}>
                    {r.number === 0
                      ? tr('Warmup', 'Разминка')
                      : `${tr('Round', 'Раунд')} ${r.number}`}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </div>
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
                <Ellipsis size={17} />
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
          {round ? (
            <>
              <div className="replay-stage">
                <aside className="replay-rosters">
                  <Team
                    side="T"
                    players={players.filter((p) => p.side === 'T')}
                  />
                  <Team
                    side="CT"
                    players={players.filter((p) => p.side === 'CT')}
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
