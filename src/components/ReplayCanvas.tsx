import { useEffect, useRef, useState } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { assetUrl } from '../lib/tauri';
import {
  activeSmokes,
  clamp,
  framePair,
  interpolatePlayer,
  playersAt,
} from '../lib/replayPlayback';
import { isWindowActive, onWindowActiveChange } from '../lib/windowActive';
import { useI18n } from '../i18n';
import type { ReplayDetail, ReplayGrenade, ReplayRound } from '../types/replay';

type Props = {
  detail: ReplayDetail;
  round: ReplayRound;
  clock: { current: number };
  lower: boolean;
  selected: ReplayGrenade | null;
  onSelect: (g: ReplayGrenade) => void;
};
const colors: Record<string, string> = {
  smoke: '#79dce7',
  flash: '#ffe084',
  HE: '#75e2a8',
  molotov: '#ff9166',
  'incendiary grenade': '#ff9166',
};
export default function ReplayCanvas({
  detail,
  round,
  clock,
  lower,
  selected,
  onSelect,
}: Props) {
  const { tr } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const clampView = (s: number, x: number, y: number) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (s <= 1 || !bounds?.width || !bounds.height) return { s: 1, x: 0, y: 0 };
    const maxX = (bounds.width * (s - 1)) / 2;
    const maxY = (bounds.height * (s - 1)) / 2;
    return { s, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };
  const zoomAt = (factor: number, x = 0, y = 0) => {
    setView((current) => {
      const s = clamp(current.s * factor, 1, 6);
      const ratio = s / current.s;
      return clampView(
        s,
        x - (x - current.x) * ratio,
        y - (y - current.y) * ratio,
      );
    });
  };
  const drag = useRef<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null>(null);
  const hits = useRef<{ x: number; y: number; g: ReplayGrenade }[]>([]);
  const imagePath = lower
    ? detail.map.lower_map_image_path
    : detail.map.map_image_path;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const image = new Image();
    let imageReady = false,
      disposed = false,
      animation = 0;
    image.onload = () => {
      imageReady = true;
      draw();
    };
    if (imagePath) image.src = assetUrl(imagePath);
    let width = 0,
      height = 0,
      dpr = 1;
    const resize = () => {
      const bounds = element.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      setView((current) => clampView(current.s, current.x, current.y));
      draw();
    };
    const radar = detail.radar;
    function draw() {
      if (disposed || !ctx || !width || !height) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#0d1115';
      ctx.fillRect(0, 0, width, height);
      if (!radar) return;
      const view = viewRef.current;
      const unit = ((Math.min(width, height) * 0.94) / 1024) * view.s;
      const ox = (width - 1024 * unit) / 2 + view.x,
        oy = (height - 1024 * unit) / 2 + view.y;
      const point = (x: number, y: number): [number, number] => [
        ox + ((x - radar!.pos_x) / radar!.scale) * unit,
        oy + ((radar!.pos_y - y) / radar!.scale) * unit,
      ];
      const visible = (z: number) =>
        radar!.split_z === null ||
        !detail.map.has_lower_radar ||
        (lower ? z < radar!.split_z : z >= radar!.split_z);
      if (imageReady) ctx.drawImage(image, ox, oy, 1024 * unit, 1024 * unit);
      ctx.lineWidth = 1;
      const tick = clock.current,
        [frame, next, t] = framePair(round, tick);
      if (!frame) return;
      for (const smoke of activeSmokes(round, tick)) {
        if (!visible(smoke.z)) continue;
        const [x, y] = point(smoke.x, smoke.y);
        ctx.fillStyle = '#c6d9dc30';
        ctx.strokeStyle = '#c6d9dc66';
        ctx.beginPath();
        ctx.arc(x, y, (144 / radar.scale) * unit, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      for (const inferno of frame.infernos ?? []) {
        ctx.fillStyle = '#ff8c3a4d';
        ctx.strokeStyle = '#ffac6c99';
        if (
          inferno.hull?.length > 2 &&
          inferno.fires.some((f) => visible(f.z))
        ) {
          ctx.beginPath();
          inferno.hull.forEach((p, i) => {
            const [x, y] = point(p.x, p.y);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
      hits.current = [];
      if (selected?.data.trajectory?.length) {
        ctx.strokeStyle = colors[selected.data.grenade_type] ?? '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        let drawing = false;
        for (const p of selected.data.trajectory) {
          if (!visible(p[2] ?? 0)) {
            drawing = false;
            continue;
          }
          const [x, y] = point(p[0], p[1]);
          if (drawing) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          drawing = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const projectile of frame.projectiles ?? []) {
        if (!visible(projectile.z)) continue;
        const other = next?.projectiles?.find((p) => p.id === projectile.id);
        const px = projectile.x + (other ? other.x - projectile.x : 0) * t,
          py = projectile.y + (other ? other.y - projectile.y : 0) * t;
        const [x, y] = point(px, py);
        const grenade = round.grenades.find((g) => g.id === projectile.id);
        ctx.fillStyle = colors[grenade?.data.grenade_type ?? ''] ?? '#f4f6f8';
        ctx.strokeStyle = '#101419';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (grenade) hits.current.push({ x, y, g: grenade });
      }
      if (
        frame.bomb &&
        !['unknown', 'exploded', 'defused'].includes(frame.bomb.state) &&
        visible(frame.bomb.z)
      ) {
        const [x, y] = point(frame.bomb.x, frame.bomb.y);
        ctx.fillStyle = frame.bomb.state === 'planted' ? '#ff5e68' : '#e6eea6';
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.strokeStyle = '#111';
        ctx.strokeRect(x - 5, y - 5, 10, 10);
      }
      playersAt(round, tick).forEach((raw, index) => {
        const player = interpolatePlayer(
          raw,
          next?.players.find((p) => p.id === raw.id),
          t,
        );
        if (!visible(player.z)) return;
        const [x, y] = point(player.x, player.y),
          color = player.side === 'CT' ? '#78b5ff' : '#ffbd70';
        ctx.globalAlpha = player.alive ? 1 : 0.4;
        if (player.alive) {
          const angle = (-player.yaw * Math.PI) / 180;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(angle) * 18, y + Math.sin(angle) * 18);
          ctx.lineTo(
            x + Math.cos(angle + 2.3) * 8,
            y + Math.sin(angle + 2.3) * 8,
          );
          ctx.lineTo(
            x + Math.cos(angle - 2.3) * 8,
            y + Math.sin(angle - 2.3) * 8,
          );
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = player.flashed ? '#ffffff' : color;
          ctx.strokeStyle = '#101419';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#111419';
          ctx.textAlign = 'center';
          ctx.font = 'bold 9px Segoe UI';
          ctx.fillText(String(index + 1), x, y + 3);
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - 4, y - 4);
          ctx.lineTo(x + 4, y + 4);
          ctx.moveTo(x + 4, y - 4);
          ctx.lineTo(x - 4, y + 4);
          ctx.stroke();
        }
        ctx.font = '11px Segoe UI';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#0a0c0f';
        ctx.strokeText(player.name, x, y + 23);
        ctx.fillStyle = '#f4f6f8';
        ctx.fillText(player.name, x, y + 23);
        ctx.globalAlpha = 1;
      });
    }
    function loop() {
      draw();
      if (isWindowActive() && !disposed)
        animation = requestAnimationFrame(loop);
    }
    const unlisten = onWindowActiveChange((active) => {
      cancelAnimationFrame(animation);
      if (active) loop();
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    if (isWindowActive()) loop();
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      observer.disconnect();
      unlisten();
      image.onload = null;
    };
  }, [detail, round, clock, lower, selected, imagePath]);
  return (
    <div className={`replay-map ${view.s > 1 ? 'is-draggable' : ''}`}>
      <canvas
        ref={canvas}
        aria-label={tr('Match radar', 'Радар матча')}
        role="img"
        tabIndex={0}
        onWheel={(e) => {
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          zoomAt(
            e.deltaY < 0 ? 1.12 : 1 / 1.12,
            e.clientX - bounds.left - bounds.width / 2,
            e.clientY - bounds.top - bounds.height / 2,
          );
        }}
        onKeyDown={(e) => {
          const bounds = e.currentTarget.getBoundingClientRect();
          const step = Math.max(
            32,
            Math.min(bounds.width, bounds.height) * 0.1,
          );
          const pans: Record<string, [number, number]> = {
            ArrowUp: [0, step],
            ArrowDown: [0, -step],
            ArrowLeft: [step, 0],
            ArrowRight: [-step, 0],
          };
          if (
            ['+', '=', '-', '_', '0', 'Home', ...Object.keys(pans)].includes(
              e.key,
            )
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === '+' || e.key === '=') zoomAt(1.18);
            else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.18);
            else if (e.key === '0' || e.key === 'Home')
              setView({ s: 1, x: 0, y: 0 });
            else {
              const [x, y] = pans[e.key];
              setView((v) => clampView(v.s, v.x + x, v.y + y));
            }
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.focus();
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            vx: view.x,
            vy: view.y,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          if (Math.hypot(dx, dy) > 3) d.moved = true;
          if (d.moved && view.s > 1)
            setView((v) => clampView(v.s, d.vx + dx, d.vy + dy));
        }}
        onPointerUp={(e) => {
          if (drag.current && !drag.current.moved) {
            const r = e.currentTarget.getBoundingClientRect();
            const hit = hits.current.find(
              (h) =>
                Math.hypot(h.x - e.clientX + r.left, h.y - e.clientY + r.top) <
                14,
            );
            if (hit) onSelect(hit.g);
          }
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onBlur={() => {
          drag.current = null;
        }}
      />
      {(!imagePath || !detail.radar) && (
        <div className="replay-map-missing">
          {tr('Radar unavailable for this map', 'Радар этой карты недоступен')}
        </div>
      )}
      <div className="replay-map-tools">
        <button
          className="icon-btn"
          aria-label={tr('Zoom in', 'Приблизить')}
          data-tip={tr('Zoom in', 'Приблизить')}
          onClick={() => zoomAt(1.18)}
        >
          <Plus size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label={tr('Zoom out', 'Отдалить')}
          data-tip={tr('Zoom out', 'Отдалить')}
          onClick={() => zoomAt(1 / 1.18)}
        >
          <Minus size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label={tr('Reset view', 'Сбросить вид')}
          data-tip={tr('Reset view', 'Сбросить вид')}
          onClick={() => setView({ s: 1, x: 0, y: 0 })}
        >
          <Crosshair size={16} />
        </button>
      </div>
    </div>
  );
}
