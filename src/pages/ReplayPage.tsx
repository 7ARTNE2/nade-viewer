import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Copy,
  FolderOpen,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from 'lucide-react';
import ReplayCanvas from '../components/ReplayCanvas';
import DestructiveConfirmDialog from '../components/DestructiveConfirmDialog';
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
  playersAt,
  timeLabel,
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
  const [tick, setTick] = useState(0);
  const [lower, setLower] = useState(false);
  const [selected, setSelected] = useState<ReplayGrenade | null>(null);
  const [deleting, setDeleting] = useState<ReplayEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const clock = useRef(0),
    resume = useRef<number | null>(null);
  const cache = useRef(new Map<number, Promise<ReplayRound>>());
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
    setRound(null);
    setSelected(null);
    setPlaying(false);
    const load = (n: number) => {
      let request = cache.current.get(n);
      if (!request) {
        request = getReplayRound(detail.id, n);
        cache.current.set(n, request);
      }
      return request;
    };
    void load(number).then(
      (v) => {
        if (!alive) return;
        const [a, b] = roundBounds(v),
          next = clamp(resume.current ?? a, a, b);
        resume.current = null;
        clock.current = next;
        setTick(next);
        setRound(v);
        const index = detail.rounds.findIndex((r) => r.number === number);
        const keep = new Set(
          detail.rounds
            .slice(Math.max(0, index - 1), index + 2)
            .map((r) => r.number),
        );
        for (const n of cache.current.keys())
          if (!keep.has(n)) cache.current.delete(n);
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
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [playing, round, detail, speed]);
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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(selected?.data.coordinates ?? '');
      showToast(tr('Coordinates copied', 'Координаты скопированы'), {
        tone: 'success',
      });
    } catch (e) {
      fail(e);
    }
  };
  const changeRound = (next: number) => {
    const p = position.current;
    if (p)
      void saveReplayPosition(p.id, p.number, clock.current).catch(
        () => undefined,
      );
    setNumber(next);
  };
  const frame = round ? framePair(round, tick)[0] : undefined;
  const players = round ? playersAt(round, tick) : [];
  const index = detail?.rounds.findIndex((r) => r.number === number) ?? -1;
  const bounds = round ? roundBounds(round) : [0, 1];
  const events =
    round?.events.filter((e) =>
      ['kill', 'bomb_planted', 'bomb_defused', 'bomb_exploded'].includes(
        e.type,
      ),
    ) ?? [];
  return (
    <div className="replay-page">
      <header className="replay-header">
        <div className="replay-heading">
          {id !== null && (
            <Link
              className="icon-btn"
              to="/replays"
              onClick={() => {
                const p = position.current;
                if (p)
                  void saveReplayPosition(p.id, p.number, clock.current).catch(
                    () => undefined,
                  );
              }}
              aria-label={tr('Replay history', 'История матчей')}
            >
              <ArrowLeft size={18} />
            </Link>
          )}
          <div>
            <span className="replay-eyebrow">
              {detail ? detail.metadata.map : 'NADE VIEWER'}
            </span>
            <h1>{detail ? tr('Match replay', 'Повтор матча') : '2D Replay'}</h1>
          </div>
        </div>
        {detail && (
          <div className="replay-match-score">
            <span className="replay-side-t">
              {frame?.players.find((p) => p.side === 'T')?.team_name ||
                detail.metadata.team_t ||
                'T'}
            </span>
            <strong>
              {round?.round.score_t ?? 0} : {round?.round.score_ct ?? 0}
            </strong>
            <span className="replay-side-ct">
              {frame?.players.find((p) => p.side === 'CT')?.team_name ||
                detail.metadata.team_ct ||
                'CT'}
            </span>
          </div>
        )}
        <div className="replay-header-actions">
          {!capability && (
            <Link className="btn" to="/tools/nade-parser">
              {tr('Update Nade Parser', 'Обновить Nade Parser')}
            </Link>
          )}
          <button
            className="btn primary"
            disabled={!capability || starting || job?.running}
            onClick={() => void open()}
          >
            <FolderOpen size={16} />
            {tr('Open demo', 'Открыть демо')}
          </button>
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
            <span>{entries.length}</span>
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
            <label>
              {tr('Round', 'Раунд')}{' '}
              <select
                aria-label={tr('Round', 'Раунд')}
                value={number ?? ''}
                onChange={(e) => changeRound(Number(e.target.value))}
              >
                {detail.rounds.map((r) => (
                  <option key={r.number} value={r.number}>
                    {r.number === 0 ? tr('Warmup', 'Разминка') : r.number}{' '}
                    {r.winner_side ? ' · ' + r.winner_side : ''}
                  </option>
                ))}
              </select>
            </label>
            <span
              className="replay-demo-name"
              title={detail.metadata.demo_filename}
            >
              {detail.metadata.demo_filename}
            </span>
            {detail.metadata.incomplete && (
              <span className="replay-incomplete">
                {tr('Incomplete demo', 'Неполное демо')}
              </span>
            )}
            {detail.map.has_lower_radar && (
              <div
                className="replay-segment"
                role="group"
                aria-label={tr('Radar level', 'Этаж')}
              >
                <button
                  className={!lower ? 'active' : ''}
                  onClick={() => setLower(false)}
                >
                  {tr('Upper', 'Верх')}
                </button>
                <button
                  className={lower ? 'active' : ''}
                  onClick={() => setLower(true)}
                >
                  {tr('Lower', 'Низ')}
                </button>
              </div>
            )}
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
                  lower={lower}
                  selected={selected}
                  onSelect={setSelected}
                />
                <aside className="replay-inspector">
                  {selected ? (
                    <section className="replay-grenade-detail">
                      <header>
                        <h2>
                          {grenadeLabel(selected.data.grenade_type, locale)}
                        </h2>
                        <button
                          className="icon-btn"
                          aria-label={tr('Close grenade', 'Закрыть гранату')}
                          onClick={() => setSelected(null)}
                        >
                          <X size={14} />
                        </button>
                      </header>
                      <strong>{selected.data.thrower}</strong>
                      <dl>
                        <dt>{tr('Throw', 'Бросок')}</dt>
                        <dd>{selected.data.throw_keys || '—'}</dd>
                        <dt>{tr('Airtime', 'Время полёта')}</dt>
                        <dd>{selected.data.airtime?.toFixed(3) ?? '—'} s</dd>
                      </dl>
                      <code>{selected.data.coordinates || '—'}</code>
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
                        <button
                          className="icon-btn"
                          disabled={!selected.data.coordinates}
                          onClick={() => void copy()}
                          aria-label={tr(
                            'Copy coordinates',
                            'Копировать координаты',
                          )}
                        >
                          <Copy size={15} />
                        </button>
                      </div>
                    </section>
                  ) : null}
                  <section className="replay-throws">
                    <h2>
                      {tr('Grenades', 'Гранаты')}{' '}
                      <small>{round.grenades.length}</small>
                    </h2>
                    {round.grenades.map((g) => (
                      <button
                        key={g.id}
                        className={`replay-throw ${selected?.id === g.id ? 'active' : ''}`}
                        onClick={() => {
                          setSelected(g);
                          seek(g.release_tick);
                          setPlaying(false);
                        }}
                      >
                        <span
                          className={`replay-nade-dot type-${g.data.grenade_type.toLowerCase().replace(/ /g, '-')}`}
                        />
                        <span>
                          <strong>{g.data.thrower}</strong>
                          <small>
                            {grenadeLabel(g.data.grenade_type, locale)}
                          </small>
                        </span>
                        <time>
                          {timeLabel(
                            (g.release_tick - bounds[0]) /
                              detail.metadata.tickrate,
                          )}
                        </time>
                      </button>
                    ))}
                  </section>
                  <section className="replay-events">
                    <h2>{tr('Events', 'События')}</h2>
                    {events.map((e, i) => (
                      <button
                        key={i}
                        className={e.tick <= tick ? 'is-past' : ''}
                        onClick={() => {
                          seek(e.tick);
                          setPlaying(false);
                        }}
                      >
                        <time>
                          {timeLabel(
                            (e.tick - bounds[0]) / detail.metadata.tickrate,
                          )}
                        </time>
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
                  >
                    <SkipBack size={18} />
                  </button>
                  <button
                    className="replay-play"
                    onClick={() => {
                      if (tick >= bounds[1]) seek(bounds[0]);
                      setPlaying((v) => !v);
                    }}
                    aria-label={
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
                  >
                    <SkipForward size={18} />
                  </button>
                </div>
                <div className="replay-timeline">
                  <div>
                    <time>
                      {timeLabel((tick - bounds[0]) / detail.metadata.tickrate)}
                    </time>
                    <span>
                      {tr('Round', 'Раунд')} {number}
                    </span>
                    <time>
                      {timeLabel(
                        (bounds[1] - bounds[0]) / detail.metadata.tickrate,
                      )}
                    </time>
                  </div>
                  <input
                    type="range"
                    min={bounds[0]}
                    max={Math.max(bounds[0] + 1, bounds[1])}
                    step={1}
                    value={tick}
                    aria-label={tr('Replay timeline', 'Таймлайн повтора')}
                    onChange={(e) => seek(Number(e.target.value))}
                  />
                  <div className="replay-event-ticks" aria-hidden="true">
                    {events.map((e, i) => (
                      <i
                        key={i}
                        style={{
                          left: `${clamp(((e.tick - bounds[0]) / (bounds[1] - bounds[0] || 1)) * 100, 0, 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <select
                  aria-label={tr('Playback speed', 'Скорость воспроизведения')}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  {[0.25, 0.5, 1, 2, 4].map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
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
