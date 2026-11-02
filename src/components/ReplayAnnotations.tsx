import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Circle,
  MoveUpRight,
  Palette,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import type { ReplayDetail, ReplayRound } from '../types/replay';
import './ReplayAnnotations.css';
import {
  loadReplayNotes,
  replayNotesKey,
  saveReplayNotes,
  type ReplayNote as Note,
  type ReplayStroke as Stroke,
} from '../lib/replayNotes';

type Point = [number, number];
type Props = {
  detail: ReplayDetail;
  round: ReplayRound;
  clock: { current: number };
  lower: boolean;
  view: { s: number; x: number; y: number };
  onPause: () => void;
  onSeek: (tick: number, lower: boolean) => void;
};
const colors = [
  ['#c7ff3d', 'Lime', 'Лайм'],
  ['#4ade80', 'Green', 'Зелёный'],
  ['#67e8f9', 'Cyan', 'Голубой'],
  ['#60a5fa', 'Blue', 'Синий'],
  ['#a78bfa', 'Purple', 'Фиолетовый'],
  ['#fb7185', 'Pink', 'Розовый'],
  ['#ef4444', 'Red', 'Красный'],
  ['#fb923c', 'Orange', 'Оранжевый'],
  ['#facc15', 'Yellow', 'Жёлтый'],
  ['#ffffff', 'White', 'Белый'],
  ['#94a3b8', 'Gray', 'Серый'],
  ['#111827', 'Black', 'Чёрный'],
] as const;

function Shape({ stroke }: { stroke: Stroke }) {
  const [start] = stroke.points;
  const end = stroke.points[stroke.points.length - 1];
  if (stroke.tool === 'circle')
    return (
      <circle
        cx={start[0]}
        cy={start[1]}
        r={Math.hypot(end[0] - start[0], end[1] - start[1])}
      />
    );
  if (stroke.tool === 'arrow') {
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const size = Math.min(
      20,
      Math.hypot(end[0] - start[0], end[1] - start[1]) / 2,
    );
    return (
      <path
        d={`M${start} L${end} M${end[0] - Math.cos(angle - 0.5) * size},${end[1] - Math.sin(angle - 0.5) * size} L${end} L${end[0] - Math.cos(angle + 0.5) * size},${end[1] - Math.sin(angle + 0.5) * size}`}
      />
    );
  }
  return <polyline points={stroke.points.map((p) => p.join(',')).join(' ')} />;
}

export default function ReplayAnnotations({
  detail,
  round,
  clock,
  lower,
  view,
  onPause,
  onSeek,
}: Props) {
  const { tr } = useI18n();
  const storageKey = replayNotesKey(detail);
  const [notes, setNotes] = useState<Note[]>(() => loadReplayNotes(storageKey));
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const requestedNoteId = searchParams.get('note');
  const [tool, setTool] = useState<Stroke['tool']>('pen');
  const [color, setColor] = useState<string>(colors[0][0]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const palette = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const gesture = useRef<Stroke | null>(null);
  const [saveError, setSaveError] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const currentNotes = notes.filter((n) => n.round === round.round_number);
  const selected = currentNotes.find(
    (n) => n.id === selectedId && n.lower === lower,
  );
  const visibleStrokes = selected?.strokes ?? [];
  const unit = ((Math.min(size.width, size.height) * 0.94) / 1024) * view.s;
  const ox = (size.width - 1024 * unit) / 2 + view.x;
  const oy = (size.height - 1024 * unit) / 2 + view.y;
  useEffect(() => {
    const note = loadReplayNotes(storageKey).find(
      (item) => item.id === requestedNoteId,
    );
    if (note?.round !== round.round_number || note.lower !== lower) return;
    setSelectedId(note.id);
    setOpen(true);
  }, [requestedNoteId, storageKey, round.round_number, lower]);
  useEffect(() => {
    try {
      saveReplayNotes(storageKey, notes);
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }, [notes, storageKey]);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    gesture.current = null;
    setDraft(null);
    setPaletteOpen(false);
  }, [round.round_number, lower, open]);
  useEffect(() => {
    if (!paletteOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !palette.current?.contains(event.target)
      )
        setPaletteOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [paletteOpen]);

  const makeNote = (): Note => ({
    id: crypto.randomUUID(),
    round: round.round_number,
    tick: clock.current,
    lower,
    text: '',
    strokes: [],
  });
  const updateNote = (update: (note: Note) => Note) => {
    const note = selected ?? makeNote();
    setSelectedId(note.id);
    setNotes((all) =>
      all.some((n) => n.id === note.id)
        ? all.map((n) => (n.id === note.id ? update(n) : n))
        : [...all, update(note)],
    );
  };
  const position = (e: React.PointerEvent<SVGSVGElement>): Point => {
    const bounds = e.currentTarget.getBoundingClientRect();
    return [
      (e.clientX - bounds.left - ox) / unit,
      (e.clientY - bounds.top - oy) / unit,
    ];
  };
  const cancel = () => {
    gesture.current = null;
    setDraft(null);
  };
  const timeLabel = (tick: number) => {
    const freezeEnd = round.round.freeze_end_tick;
    const freezing = freezeEnd !== null && tick < freezeEnd;
    const seconds = Math.max(
      0,
      freezing
        ? Math.ceil((freezeEnd - tick) / detail.metadata.tickrate)
        : Math.floor(
            (tick - (freezeEnd ?? round.round.start_tick)) /
              detail.metadata.tickrate,
          ),
    );
    return `${freezing ? tr('F ', 'Ф ') : ''}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return (
    <>
      <svg
        ref={svg}
        className={`replay-annotations ${open && detail.radar ? 'is-drawing' : ''}`}
        aria-label={tr('Replay drawings', 'Рисунки реплея')}
        onPointerDown={(e) => {
          if (!open || !detail.radar || e.button !== 0) return;
          e.preventDefault();
          onPause();
          e.currentTarget.setPointerCapture(e.pointerId);
          const start = position(e);
          gesture.current = { tool, color, points: [start, start] };
          setDraft(gesture.current);
        }}
        onPointerMove={(e) => {
          const stroke = gesture.current;
          if (!stroke) return;
          const end = position(e);
          const last = stroke.points[stroke.points.length - 1];
          if (Math.hypot(end[0] - last[0], end[1] - last[1]) * unit < 1) return;
          gesture.current = {
            ...stroke,
            points:
              stroke.tool === 'pen'
                ? [...stroke.points, end]
                : [stroke.points[0], end],
          };
          setDraft(gesture.current);
        }}
        onPointerUp={(e) => {
          const stroke = gesture.current;
          if (!stroke) return;
          updateNote((n) => ({ ...n, strokes: [...n.strokes, stroke] }));
          cancel();
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        {open && (
          <g
            transform={`translate(${ox} ${oy}) scale(${unit})`}
            fill="none"
            strokeWidth={3 / unit}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {[...visibleStrokes, ...(draft ? [draft] : [])].map((stroke, i) => (
              <g key={i} stroke={stroke.color}>
                <Shape stroke={stroke} />
              </g>
            ))}
          </g>
        )}
      </svg>
      <button
        className={`replay-notes-toggle ${open ? 'active' : ''}`}
        aria-pressed={open}
        onClick={() => {
          if (!open) onPause();
          setOpen(!open);
        }}
      >
        <StickyNote size={15} />
        {tr('Notes', 'Заметки')}
        {currentNotes.length > 0 && <small>{currentNotes.length}</small>}
      </button>
      {open && (
        <section
          className="replay-notes-panel"
          aria-label={tr('Replay notes', 'Заметки реплея')}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <header>
            <strong>
              {tr('Notes', 'Заметки')} · R{round.round_number}
            </strong>
            <button
              aria-label={tr('Close notes', 'Закрыть заметки')}
              data-tip={tr('Close notes', 'Закрыть заметки')}
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          <div
            className="replay-drawing-tools"
            role="group"
            aria-label={tr('Drawing tools', 'Инструменты рисования')}
          >
            {(
              [
                ['pen', Pencil, tr('Pen', 'Карандаш')],
                ['arrow', MoveUpRight, tr('Arrow', 'Стрелка')],
                ['circle', Circle, tr('Circle', 'Круг')],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                aria-label={label}
                data-tip={label}
                aria-pressed={tool === value}
                onClick={() => setTool(value)}
              >
                <Icon size={16} />
              </button>
            ))}
            <button
              aria-label={tr('Undo drawing', 'Отменить рисунок')}
              data-tip={tr('Undo drawing', 'Отменить рисунок')}
              disabled={!visibleStrokes.length}
              onClick={() =>
                updateNote((n) => ({ ...n, strokes: n.strokes.slice(0, -1) }))
              }
            >
              <Undo2 size={16} />
            </button>
            <div className="replay-palette-control" ref={palette}>
              <button
                className="replay-palette-toggle"
                aria-label={tr('Color palette', 'Палитра цветов')}
                data-tip={tr('Color palette', 'Палитра цветов')}
                aria-expanded={paletteOpen}
                onClick={() => setPaletteOpen((value) => !value)}
              >
                <Palette size={16} />
                <span
                  className="replay-color-swatch"
                  style={{ background: color }}
                />
              </button>
              {paletteOpen && (
                <div
                  className="replay-color-palette"
                  role="group"
                  aria-label={tr('Drawing color', 'Цвет рисования')}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setPaletteOpen(false);
                      palette.current?.querySelector('button')?.focus();
                    }
                  }}
                >
                  <div className="replay-palette-heading">
                    <strong>{tr('Drawing color', 'Цвет рисования')}</strong>
                    <code>{color.toUpperCase()}</code>
                  </div>
                  <div className="replay-color-presets">
                    {colors.map(([value, english, russian]) => (
                      <button
                        key={value}
                        className="replay-drawing-color"
                        aria-label={tr(english, russian)}
                        data-tip={tr(english, russian)}
                        aria-pressed={color.toLowerCase() === value}
                        onClick={() => {
                          setColor(value);
                          setPaletteOpen(false);
                        }}
                      >
                        <span
                          className="replay-color-swatch"
                          style={{ background: value }}
                        />
                      </button>
                    ))}
                  </div>
                  <label className="replay-custom-color">
                    <input
                      type="color"
                      value={color}
                      aria-label={tr('Custom color', 'Свой цвет')}
                      data-tip={tr('Custom color', 'Свой цвет')}
                      onChange={(e) => setColor(e.target.value.toLowerCase())}
                    />
                    <span>{tr('Custom color', 'Свой цвет')}</span>
                  </label>
                </div>
              )}
            </div>
          </div>
          <p>
            {tr(
              'Draw on the radar. Notes are saved automatically.',
              'Рисуйте на радаре. Заметки сохраняются автоматически.',
            )}
          </p>
          <div className="replay-note-actions">
            <button
              onClick={() => {
                onPause();
                const note = makeNote();
                setNotes((all) => [...all, note]);
                setSelectedId(note.id);
              }}
            >
              <Plus size={14} />
              {tr('New note', 'Новая заметка')}
            </button>
            {selected && (
              <button
                aria-label={tr('Delete note', 'Удалить заметку')}
                data-tip={tr('Delete note', 'Удалить заметку')}
                onClick={() => {
                  setNotes((all) => all.filter((n) => n.id !== selected.id));
                  setSelectedId(null);
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <label className="replay-note-editor">
            <span>
              {selected
                ? timeLabel(selected.tick)
                : tr('Current moment', 'Текущий момент')}
              {selected?.lower ? ` · ${tr('Lower', 'Нижний')}` : ''}
            </span>
            <textarea
              aria-label={tr('Note text', 'Текст заметки')}
              placeholder={tr(
                'Add a note about this moment…',
                'Добавьте заметку к этому моменту…',
              )}
              value={selected?.text ?? ''}
              onFocus={onPause}
              onChange={(e) =>
                updateNote((n) => ({ ...n, text: e.target.value }))
              }
            />
          </label>
          <div className="replay-note-list">
            {currentNotes
              .slice()
              .sort((a, b) => a.tick - b.tick)
              .map((note) => (
                <button
                  key={note.id}
                  aria-pressed={selected?.id === note.id}
                  onClick={() => {
                    onPause();
                    setSelectedId(note.id);
                    onSeek(note.tick, note.lower);
                  }}
                >
                  <time>{timeLabel(note.tick)}</time>
                  <span>
                    {note.text.trim() || tr('Drawing', 'Рисунок')}
                    {note.lower ? ` · ${tr('Lower', 'Нижний')}` : ''}
                  </span>
                </button>
              ))}
          </div>
          {saveError && (
            <p role="alert">
              {tr(
                'Unable to save notes. Local storage is full or unavailable.',
                'Не удалось сохранить заметки: локальное хранилище заполнено или недоступно.',
              )}
            </p>
          )}
        </section>
      )}
    </>
  );
}
