import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import c4Icon from '../assets/equipment_icons/c4.svg';
import { assetUrl } from '../lib/tauri';
import {
  activeSmokes,
  buildSmokeTimeline,
  clamp,
  framePair,
  interpolatePlayer,
  playersAt,
} from '../lib/replayPlayback';
import { isWindowActive, onWindowActiveChange } from '../lib/windowActive';
import { weaponIcon } from '../lib/weaponIcons';
import { useI18n } from '../i18n';
import type { ReplayDetail, ReplayFrame, ReplayGrenade, ReplayRound } from '../types/replay';

type Props = {
  detail: ReplayDetail;
  round: ReplayRound;
  clock: { current: number };
  tickrate: number;
  lower: boolean;
  selected: ReplayGrenade | null;
  copiedGrenadeId: string | null;
  onSelect: (g: ReplayGrenade) => void;
  onCopyCoordinates: (g: ReplayGrenade) => void;
};
const colors: Record<string, string> = {
  smoke: '#67e8f9',
  flash: '#fbbf24',
  HE: '#34d399',
  molotov: '#fb7185',
  'incendiary grenade': '#f97316',
};
const FLASH_FULL_RADIUS_GAME = 400;
const FLASH_FADE_RADIUS_GAME = 1000;
const FLASH_EFFECT_SECONDS = 0.6;
const HE_RADIUS_GAME = 400;
// Keep the HE burst close to Nadegrid's fast fire-core animation.
const HE_EFFECT_SECONDS = 0.82;
const TRAJECTORY_FADE_SECONDS = 0.9;
const SMOKE_RADIUS_GAME = 144;
const INFERNO_RADIUS_GAME = 116;
const SMOKE_SIDE_COLORS: Record<string, string> = {
  T: '#fb923c',
  CT: '#38bdf8',
};
export default function ReplayCanvas({
  detail,
  round,
  clock,
  tickrate,
  lower,
  selected,
  copiedGrenadeId,
  onSelect,
  onCopyCoordinates,
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
  const damageState = useRef(
    new Map<string, { health: number; damage: number; started: number }>(),
  );
  const hits = useRef<{ x: number; y: number; g: ReplayGrenade }[]>([]);
  const trajectoryHits = useRef<
    { ax: number; ay: number; bx: number; by: number; g: ReplayGrenade }[]
  >([]);
  const findGrenadeAt = (x: number, y: number) => {
    const pointHit = hits.current.find(
      (h) => Math.hypot(h.x - x, h.y - y) < 14,
    );
    if (pointHit) return pointHit.g;
    let lineHit: (typeof trajectoryHits.current)[number] | undefined;
    let lineDistance = 11;
    for (const candidate of trajectoryHits.current) {
      const dx = candidate.bx - candidate.ax;
      const dy = candidate.by - candidate.ay;
      const lengthSquared = dx * dx + dy * dy || 1;
      const projection = Math.max(
        0,
        Math.min(
          1,
          ((x - candidate.ax) * dx + (y - candidate.ay) * dy) / lengthSquared,
        ),
      );
      const distance = Math.hypot(
        x - (candidate.ax + projection * dx),
        y - (candidate.ay + projection * dy),
      );
      if (distance < lineDistance) {
        lineDistance = distance;
        lineHit = candidate;
      }
    }
    return lineHit?.g;
  };
  const imagePath = lower
    ? detail.map.lower_map_image_path
    : detail.map.map_image_path;
  const smokeTimeline = useMemo(() => buildSmokeTimeline(round), [round]);
  const killEvents = useMemo(
    () => round.events.filter((event) => event.type === 'kill'),
    [round],
  );
  const killTicks = useMemo(() => {
    const ticks = new Map<string, number>();
    for (const event of killEvents) {
      if (!event.target_id) continue;
      const previous = ticks.get(event.target_id);
      if (previous === undefined || event.tick < previous)
        ticks.set(event.target_id, event.tick);
    }
    return ticks;
  }, [killEvents]);
  const explosionEvents = useMemo(
    () =>
      round.events.filter(
        (event) =>
          (event.type === 'flash_explode' || event.type === 'he_explode') &&
          event.x !== null &&
          event.y !== null,
      ),
    [round],
  );
  const bombEvents = useMemo(
    () =>
      round.events.filter(
        (event) =>
          event.type === 'bomb_exploded' &&
          event.x !== null &&
          event.y !== null,
      ),
    [round],
  );
  const grenadeById = useMemo(
    () => new Map(round.grenades.map((grenade) => [grenade.id, grenade])),
    [round],
  );
  const fireGrenades = useMemo(
    () =>
      round.grenades.filter(
        (grenade) =>
          (grenade.data.grenade_type === 'molotov' ||
            grenade.data.grenade_type === 'incendiary grenade') &&
          typeof grenade.data.explode_pos_x === 'number' &&
          typeof grenade.data.explode_pos_y === 'number',
      ),
    [round],
  );
  const trajectoryMovementTicks = useMemo(() => {
    const tracks = new Map<
      string,
      {
        x: number;
        y: number;
        ticks: number[];
        points: [number, number, number][];
      }
    >();
    const radar = detail.radar;
    if (!radar) return tracks;
    for (const frame of round.frames) {
      for (const projectile of frame.projectiles ?? []) {
        if (
          radar.split_z !== null &&
          detail.map.has_lower_radar &&
          (lower ? projectile.z >= radar.split_z : projectile.z < radar.split_z)
        )
          continue;
        const track = tracks.get(projectile.id);
        // Match Nadegrid's 1.5 radar-unit movement threshold. A landed smoke
        // remains an entity, but its presence must not keep the trail alive.
        if (
          track &&
          Math.hypot(projectile.x - track.x, projectile.y - track.y) <
            1.5 * radar.scale
        )
          continue;
        if (track) {
          track.x = projectile.x;
          track.y = projectile.y;
          track.ticks.push(frame.tick);
        } else {
          tracks.set(projectile.id, {
            x: projectile.x,
            y: projectile.y,
            ticks: [frame.tick],
            points: [],
          });
        }
      }
    }
    for (const grenade of round.grenades) {
      const track = tracks.get(grenade.id);
      if (!track || !grenade.data.trajectory?.length) continue;
      track.points = grenade.data.trajectory.map(
        (point) => [point[0], point[1], point[2] ?? 0] as [number, number, number],
      );
    }
    return tracks;
  }, [round, detail.radar, detail.map.has_lower_radar, lower]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const image = new Image();
    const bombImage = new Image();
    const weaponImages = new Map<string, HTMLImageElement>();
    bombImage.onload = draw;
    bombImage.src = c4Icon;
    let imageReady = false,
      disposed = false,
      animation = 0;
    image.onload = () => {
      imageReady = true;
      draw();
    };
    if (imagePath) image.src = assetUrl(imagePath);
    const activeWeaponImage = (name: string) => {
      const key = name.trim();
      if (!key) return null;
      const cached = weaponImages.get(key);
      if (cached) return cached;
      const src = weaponIcon(key);
      if (!src) return null;
      const weaponImage = new Image();
      weaponImage.onload = draw;
      weaponImage.src = src;
      weaponImages.set(key, weaponImage);
      return weaponImage;
    };
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
      const nextProjectiles = new Map(
        (next?.projectiles ?? []).map((projectile) => [
          projectile.id,
          projectile,
        ]),
      );
      const nextPlayers = new Map(
        (next?.players ?? []).map((player) => [player.id, player]),
      );
      const now = performance.now();
      const visibleSmokes = activeSmokes(
        round,
        tick,
        tickrate,
        smokeTimeline,
      ).filter((smoke) => visible(smoke.z));
      for (const smoke of visibleSmokes) {
        const [x, y] = point(smoke.x, smoke.y);
        const radius = (SMOKE_RADIUS_GAME / radar.scale) * unit;
        const sideColor = SMOKE_SIDE_COLORS[smoke.side?.toUpperCase() ?? ''];
        const ending = smoke.remainingSeconds <= 5;
        ctx.save();
        ctx.fillStyle = 'rgba(30,41,59,0.62)';
        ctx.strokeStyle = sideColor
          ? `${sideColor}${ending ? 'cc' : '9e'}`
          : 'rgba(203,213,225,0.38)';
        ctx.lineWidth = 2;
        ctx.shadowColor = sideColor ?? '#94a3b8';
        ctx.shadowBlur = sideColor ? (ending ? 12 : 14) : 7;
        if (ending) {
          const pulse = (now % 1350) / 1350;
          ctx.globalAlpha = (1 - pulse) * 0.75;
          ctx.shadowBlur = 0;
          ctx.strokeStyle = sideColor ?? '#94a3b8';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, y, radius * (1 + pulse * 0.2), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (ending) ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      if (frame.bomb && visible(frame.bomb.z)) {
        const [bx, by] = point(frame.bomb.x, frame.bomb.y);
        const planted = frame.bomb.state === 'planted';
        const pulse = 0.5 + 0.5 * Math.sin(now / 180);
        if (planted) {
          const bombRadius = Math.max(10, (72 / radar.scale) * unit);
          ctx.save();
          ctx.globalAlpha = 0.2 + pulse * 0.18;
          ctx.strokeStyle = '#ff5e68';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(bx, by, bombRadius * (0.9 + pulse * 0.2), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#ff5e68';
          ctx.beginPath();
          ctx.arc(bx, by, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      for (const inferno of frame.infernos ?? []) {
        if (!inferno.hull?.length || !inferno.fires.some((f) => visible(f.z)))
          continue;
        const center = inferno.hull.reduce(
          (sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y }),
          { x: 0, y: 0 },
        );
        center.x /= inferno.hull.length;
        center.y /= inferno.hull.length;
        const source = fireGrenades
          .map((g) => ({
            grenade: g,
            distance: Math.hypot(
              (g.data.explode_pos_x ?? 0) - center.x,
              (g.data.explode_pos_y ?? 0) - center.y,
            ),
          }))
          .sort((a, b) => a.distance - b.distance)[0];
        const incendiary =
          source && source.distance <= 260
            ? source.grenade.data.grenade_type === 'incendiary grenade'
            : false;
        const palette = incendiary
          ? {
              edge: '#fb923c',
              glow: '#ea580c',
              fill: 'rgba(154,52,18,0.2)',
              inner: '#fff7ae',
              flame: '#fb923c',
              hot: '#c2410c',
            }
          : {
              edge: '#ef4444',
              glow: '#f97316',
              fill: 'rgba(194,65,12,0.24)',
              inner: '#fff7c2',
              flame: '#f97316',
              hot: '#dc2626',
            };
        const [cx, cy] = point(center.x, center.y);
        ctx.save();
        ctx.beginPath();
        inferno.hull.forEach((p, i) => {
          const [x, y] = point(p.x, p.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = palette.fill;
        ctx.strokeStyle = `${palette.edge}aa`;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = palette.glow;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.stroke();
        // Keep a visible fire core even when Windows/WebView reduces motion
        // or throttles animation frames. The animated hotspots below are an
        // enhancement, never the only representation of the inferno.
        const core = ctx.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          (INFERNO_RADIUS_GAME / radar.scale) * unit * 0.88,
        );
        core.addColorStop(0, `${palette.inner}b8`);
        core.addColorStop(0.28, `${palette.flame}72`);
        core.addColorStop(0.7, `${palette.glow}2e`);
        core.addColorStop(1, `${palette.glow}00`);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(
          cx,
          cy,
          (INFERNO_RADIUS_GAME / radar.scale) * unit * 0.88,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        inferno.fires.forEach((fire, fireIndex) => {
          if (!visible(fire.z)) return;
          const [x, y] = point(fire.x, fire.y);
          const phase = (now / 260 + fireIndex * 1.73 + inferno.id.length) % 1;
          const pulse = 0.82 + Math.sin(phase * Math.PI * 2) * 0.14;
          const radius = Math.max(
            3,
            (INFERNO_RADIUS_GAME / radar.scale) *
              unit *
              (0.16 + (fireIndex % 3) * 0.035),
          );
          const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.5);
          glow.addColorStop(0, `${palette.inner}a8`);
          glow.addColorStop(0.3, `${palette.flame}88`);
          glow.addColorStop(0.72, `${palette.glow}4d`);
          glow.addColorStop(1, `${palette.glow}00`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, radius * 2.3, 0, Math.PI * 2);
          ctx.fill();

          // Draw an actual flame tongue instead of a colored dot. The
          // varying tip and lean create a readable fire silhouette at any
          // Windows animation/reduced-motion setting.
          const lean = Math.sin(phase * Math.PI * 2) * radius * 0.35;
          const tongue = radius * (1.55 + pulse * 0.35);
          const flameGradient = ctx.createLinearGradient(
            x,
            y + radius * 0.75,
            x + lean,
            y - tongue,
          );
          flameGradient.addColorStop(0, `${palette.hot}e6`);
          flameGradient.addColorStop(0.42, `${palette.flame}ee`);
          flameGradient.addColorStop(0.78, `${palette.inner}f0`);
          flameGradient.addColorStop(1, `${palette.inner}00`);
          ctx.fillStyle = flameGradient;
          ctx.beginPath();
          ctx.moveTo(x - radius * 0.72, y + radius * 0.62);
          ctx.quadraticCurveTo(
            x - radius * 0.52,
            y - radius * 0.08,
            x - radius * 0.18 + lean * 0.18,
            y - radius * 0.72,
          );
          ctx.quadraticCurveTo(
            x - radius * 0.03 + lean * 0.2,
            y - radius * 1.18,
            x + lean,
            y - tongue,
          );
          ctx.quadraticCurveTo(
            x + radius * 0.24 + lean * 0.2,
            y - radius * 0.98,
            x + radius * 0.52,
            y - radius * 0.38,
          );
          ctx.quadraticCurveTo(
            x + radius * 0.68,
            y + radius * 0.08,
            x + radius * 0.72,
            y + radius * 0.62,
          );
          ctx.closePath();
          ctx.fill();
        });
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        inferno.hull.forEach((p, i) => {
          const [x, y] = point(p.x, p.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.strokeStyle = `${palette.edge}aa`;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = palette.glow;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
      }
      const drawExplosionEffects = () => {
        const events = explosionEvents.filter((event) => visible(event.z ?? 0));
        for (const event of events) {
          const age = (tick - event.tick) / tickrate;
          const isFlash = event.type === 'flash_explode';
          const duration = isFlash ? FLASH_EFFECT_SECONDS : HE_EFFECT_SECONDS;
          if (age < 0 || age > duration) continue;
          const [x, y] = point(event.x!, event.y!);
          const progress = clamp(age / duration, 0, 1);
          const fade = 1 - progress;
          const fullRadius =
            ((isFlash ? FLASH_FULL_RADIUS_GAME : HE_RADIUS_GAME) /
              radar!.scale) *
            unit;
          const fadeRadius = (FLASH_FADE_RADIUS_GAME / radar!.scale) * unit;
          ctx.save();
          if (isFlash) {
            ctx.globalAlpha = 0.16 * fade;
            ctx.fillStyle = '#fff7c2';
            ctx.beginPath();
            ctx.arc(x, y, fadeRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.3 * fade;
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 7]);
            ctx.beginPath();
            ctx.arc(x, y, fadeRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            const flashGradient = ctx.createRadialGradient(
              x,
              y,
              fullRadius * 0.05,
              x,
              y,
              fullRadius * (0.45 + progress * 0.55),
            );
            flashGradient.addColorStop(0, `rgba(255,255,255,${0.72 * fade})`);
            flashGradient.addColorStop(0.3, `rgba(254,249,195,${0.48 * fade})`);
            flashGradient.addColorStop(0.7, `rgba(251,191,36,${0.22 * fade})`);
            flashGradient.addColorStop(1, 'rgba(251,191,36,0)');
            ctx.fillStyle = flashGradient;
            ctx.beginPath();
            ctx.arc(x, y, fullRadius, 0, Math.PI * 2);
            ctx.fill();
            const coreRadius = fullRadius;
            const coreGradient = ctx.createRadialGradient(
              x,
              y,
              0,
              x,
              y,
              coreRadius,
            );
            coreGradient.addColorStop(0, `rgba(255,255,255,${0.98 * fade})`);
            coreGradient.addColorStop(0.42, `rgba(255,250,205,${0.78 * fade})`);
            coreGradient.addColorStop(0.78, `rgba(251,191,36,${0.34 * fade})`);
            coreGradient.addColorStop(1, 'rgba(251,191,36,0)');
            ctx.fillStyle = coreGradient;
            ctx.beginPath();
            ctx.arc(x, y, coreRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.82 * fade;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, coreRadius, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            const burst = clamp(progress / 0.42, 0, 1);
            const radius = fullRadius * (0.32 + burst * 0.68);
            const heGradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
            const fireFade = 1 - clamp(progress / 0.78, 0, 1);
            heGradient.addColorStop(0, `rgba(255,245,190,${0.98 * fireFade})`);
            heGradient.addColorStop(
              0.14,
              `rgba(251,146,60,${0.92 * fireFade})`,
            );
            heGradient.addColorStop(0.34, `rgba(185,28,28,${0.74 * fade})`);
            heGradient.addColorStop(0.58, `rgba(15,23,42,${0.68 * fade})`);
            heGradient.addColorStop(1, 'rgba(2,6,23,0)');
            ctx.fillStyle = heGradient;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.55 * fade;
            ctx.strokeStyle = '#f97316';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, radius * 0.68, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
        for (const event of bombEvents) {
          const age = (tick - event.tick) / tickrate;
          if (age < 0 || age > 1.5) continue;
          const [x, y] = point(event.x!, event.y!);
          const progress = clamp(age / 1.5, 0, 1);
          const radius = Math.max(16, (210 / radar!.scale) * unit) * (0.35 + progress * 0.65);
          ctx.save();
          ctx.globalAlpha = (1 - progress) * 0.7;
          ctx.fillStyle = '#ffb36b';
          ctx.beginPath();
          ctx.arc(x, y, radius * 0.45, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = (1 - progress) * 0.9;
          ctx.strokeStyle = '#ff5e68';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      };
      drawExplosionEffects();
      hits.current = [];
      trajectoryHits.current = [];
      for (const grenade of round.grenades) {
        if (grenade.release_tick > tick || !grenade.data.trajectory?.length)
          continue;
        const trajectory = trajectoryMovementTicks.get(grenade.id);
        const movementTicks = trajectory?.ticks;
        if (!movementTicks || !trajectory?.points.length) continue;
        let lo = 0,
          hi = movementTicks.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (movementTicks[mid] <= tick) lo = mid + 1;
          else hi = mid;
        }
        if (lo < 2) continue;
        const age = tick - movementTicks[lo - 1];
        const fadeTicks = tickrate * TRAJECTORY_FADE_SECONDS;
        if (age > Math.round(fadeTicks)) continue;
        const opacity = Math.max(0.18, 1 - age / Math.max(1, fadeTicks));
        const active = selected?.id === grenade.id;
        const copied = copiedGrenadeId === grenade.id;
        const trajectoryColor = copied
          ? '#c8f43d'
          : (colors[grenade.data.grenade_type] ?? '#f4f6f8');
        ctx.save();
        ctx.globalAlpha = copied || active ? 1 : 0.72 * opacity;
        ctx.strokeStyle = trajectoryColor;
        ctx.lineWidth = copied ? 3.5 : active ? 3.5 : 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = trajectoryColor;
        ctx.shadowBlur = copied ? 10 : active ? 7 : 3;
        ctx.beginPath();
        let previous: [number, number] | null = null;
        for (const p of trajectory.points) {
          if (!visible(p[2])) {
            previous = null;
            continue;
          }
          const [x, y] = point(p[0], p[1]);
          if (previous) {
            ctx.lineTo(x, y);
            trajectoryHits.current.push({
              ax: previous[0],
              ay: previous[1],
              bx: x,
              by: y,
              g: grenade,
            });
          } else ctx.moveTo(x, y);
          previous = [x, y];
        }
        ctx.stroke();
        ctx.restore();
      }
      for (const projectile of frame.projectiles ?? []) {
        if (!visible(projectile.z)) continue;
        const other = nextProjectiles.get(projectile.id);
        const px = projectile.x + (other ? other.x - projectile.x : 0) * t,
          py = projectile.y + (other ? other.y - projectile.y : 0) * t;
        const [x, y] = point(px, py);
        const grenade = grenadeById.get(projectile.id);
        // Once a smoke has bloomed, its timer replaces the grenade marker at
        // the center of the cloud. Keep the marker visible while it is flying,
        // then remove it as soon as it reaches the active smoke.
        const insideActiveSmoke =
          grenade?.data.grenade_type === 'smoke' &&
          visibleSmokes.some(
            (smoke) => Math.hypot(smoke.x - px, smoke.y - py) <= 36,
          );
        if (insideActiveSmoke) continue;
        ctx.fillStyle = colors[grenade?.data.grenade_type ?? ''] ?? '#f4f6f8';
        ctx.strokeStyle = '#101419';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (grenade) hits.current.push({ x, y, g: grenade });
      }
      // Draw smoke timers after projectiles so the moving grenade point cannot
      // cover the remaining-time label in the center of the cloud.
      for (const smoke of visibleSmokes) {
        const [x, y] = point(smoke.x, smoke.y);
        const radius = (SMOKE_RADIUS_GAME / radar.scale) * unit;
        ctx.save();
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = 'rgba(2,6,23,0.9)';
        ctx.lineWidth = Math.max(1.5, radius * 0.055);
        ctx.font = `900 ${Math.max(9, Math.min(18, radius * 0.62))}px Segoe UI`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeText(`${smoke.remainingSeconds.toFixed(1)}s`, x, y);
        ctx.fillText(`${smoke.remainingSeconds.toFixed(1)}s`, x, y);
        ctx.restore();
      }
      if (
        frame.bomb &&
        !['unknown', 'exploded', 'defused'].includes(frame.bomb.state) &&
        frame.bomb.state !== 'carried' &&
        visible(frame.bomb.z)
      ) {
        const [x, y] = point(frame.bomb.x, frame.bomb.y);
        ctx.fillStyle = frame.bomb.state === 'planted' ? '#ff5e68' : '#e6eea6';
        if (bombImage.complete && bombImage.naturalWidth > 0) {
          ctx.drawImage(bombImage, x - 9, y - 9, 18, 18);
        } else {
          ctx.fillRect(x - 5, y - 5, 10, 10);
        }
      }
      // Short-lived shot tracers and hit markers, matching the compact visual
      // treatment used by Nadegrid. Weapon-fire events use the shooter's view
      // direction; damage/kill events terminate at the victim position.
      const playerById = new Map(frame.players.map((player) => [player.id, player]));
      const tracerAge = (event: ReplayRound['events'][number]) => tick - event.tick;
      const drawTracer = (
        event: ReplayRound['events'][number],
        shooter: ReplayFrame['players'][number],
        target: { x: number; y: number } | null,
        hit: boolean,
        windowTicks: number,
      ) => {
        const age = tracerAge(event);
        if (age < 0 || age > windowTicks || !visible(shooter.z)) return;
        const start = point(shooter.x, shooter.y);
        let end: [number, number];
        if (target) {
          end = point(target.x, target.y);
        } else {
          const rawYaw = Number(event.data?.yaw ?? shooter.yaw);
          const angle = (-rawYaw * Math.PI) / 180;
          // Nadegrid uses a short, screen-sized shot segment that starts just
          // outside the player marker instead of a long world-space ray.
          const directionX = Math.cos(angle);
          const directionY = Math.sin(angle);
          const fromOffset = 9;
          const toOffset = 46;
          end = [
            start[0] + directionX * toOffset,
            start[1] + directionY * toOffset,
          ];
          start[0] += directionX * fromOffset;
          start[1] += directionY * fromOffset;
        }
        const color = shooter.side === 'CT' ? '#8dbdff' : '#ff986b';
        const opacity = Math.max(0.12, 1 - age / Math.max(1, windowTicks));
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.strokeStyle = color;
        ctx.lineWidth = hit && ['damage', 'bullet_damage', 'kill'].includes(event.type) ? 4 : 1.5;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = hit ? 12 : 8;
        ctx.beginPath();
        ctx.moveTo(start[0], start[1]);
        ctx.lineTo(end[0], end[1]);
        ctx.stroke();
        if (hit) {
          ctx.fillStyle = color;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(end[0], end[1], 6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      };
      const fireWindow = Math.max(3, Math.round(tickrate * 0.14));
      for (const event of round.events) {
        if (event.tick > tick || tracerAge(event) > fireWindow || event.type !== 'weapon_fire') continue;
        const shooter = event.player_id ? playerById.get(event.player_id) : undefined;
        if (shooter) drawTracer(event, shooter, null, false, fireWindow);
      }
      const hitWindow = Math.max(3, Math.round(tickrate * 0.28));
      for (const event of round.events) {
        if (event.tick > tick || tracerAge(event) > hitWindow || !['damage', 'bullet_damage', 'kill'].includes(event.type)) continue;
        const shooter = event.player_id ? playerById.get(event.player_id) : undefined;
        if (!shooter) continue;
        const victim = event.target_id ? playerById.get(event.target_id) : undefined;
        const target = victim
          ? { x: victim.x, y: victim.y }
          : typeof event.x === 'number' && typeof event.y === 'number'
            ? { x: event.x, y: event.y }
            : null;
        drawTracer(event, shooter, target, true, hitWindow);
      }
      playersAt(round, tick, killEvents, killTicks, frame).forEach((raw) => {
        const player = interpolatePlayer(
          raw,
          nextPlayers.get(raw.id),
          t,
        );
        const previous = damageState.current.get(player.id);
        const health = Math.max(0, Math.round(player.health));
        if (previous && health < previous.health) {
          damageState.current.set(player.id, {
            health,
            damage: previous.health - health,
            started: now,
          });
        } else if (!previous || health > previous.health) {
          damageState.current.set(player.id, {
            health,
            damage: 0,
            started: previous?.started ?? now,
          });
        } else {
          previous.health = health;
        }
        if (!visible(player.z)) return;
        const [x, y] = point(player.x, player.y),
          color = player.side === 'CT' ? '#8dbdff' : '#ff986b';
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
          // Show the item currently held by the player, matching the compact
          // weapon badge used by Nadegrid. Keep it outside the player circle
          // so it remains readable without changing the player marker size.
          const activeName = String(player.active_weapon ?? '').trim();
          const activeImage = activeWeaponImage(activeName);
          if (activeImage?.complete && activeImage.naturalWidth > 0) {
            const activeLower = activeName.toLowerCase();
            const utility = activeLower.includes('grenade') ||
              activeLower.includes('flashbang') ||
              activeLower.includes('smoke') ||
              activeLower.includes('molotov') ||
              activeLower.includes('incendiary') ||
              activeLower.includes('decoy') ||
              activeLower.includes('knife') ||
              activeLower === 'c4' || activeLower.includes('bomb');
            const maxWidth = utility ? 16 : 25;
            const maxHeight = utility ? 16 : 13;
            const scale = Math.min(maxWidth / Math.max(1, activeImage.naturalWidth), maxHeight / Math.max(1, activeImage.naturalHeight));
            const iconWidth = activeImage.naturalWidth * scale;
            const iconHeight = activeImage.naturalHeight * scale;
            ctx.save();
            ctx.globalAlpha = player.alive ? 0.94 : 0.45;
            ctx.shadowColor = '#05070a';
            ctx.shadowBlur = 3;
            ctx.shadowOffsetY = 1;
            ctx.drawImage(activeImage, x + 11, y - iconHeight / 2, iconWidth, iconHeight);
            ctx.restore();
          }
          // Keep the carried C4 on the player's left side. The badge sits
          // outside the marker, leaving the HP value in the centre and the
          // active weapon icon on the right unobstructed.
          if (frame.bomb?.state === 'carried' && frame.bomb.carrier_id === player.id) {
            ctx.save();
            ctx.globalAlpha = 0.98;
            ctx.fillStyle = 'rgba(9, 12, 16, 0.9)';
            ctx.strokeStyle = '#ff5e68';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(x - 24, y - 7, 14, 14, 4);
            ctx.fill();
            ctx.stroke();
            if (bombImage.complete && bombImage.naturalWidth > 0) {
              ctx.drawImage(bombImage, x - 22.5, y - 5.5, 11, 11);
            }
            ctx.restore();
          }
          if (player.flashed) {
            const flashProgress = clamp((player.flash_ms ?? 0) / 2000, 0, 1);
            ctx.save();
            ctx.globalAlpha = 0.2 + flashProgress * 0.35;
            ctx.strokeStyle = '#fff7c2';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 13 + flashProgress * 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.16)';
            ctx.beginPath();
            ctx.arc(x, y, 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
          const action = player.planting || player.defusing ? player : null;
          if (action) {
            const actionType = player.defusing ? 'bomb_defuse_start' : 'bomb_plant_begin';
            const actionEvents = round.events.filter(
              (event) =>
                event.type === actionType &&
                event.player_id === player.id &&
                event.tick <= tick,
            );
            const startEvent = actionEvents[actionEvents.length - 1];
            const duration = player.defusing ? (player.has_defuse_kit ? 5 : 10) : 3.2;
            const progress = startEvent ? clamp((tick - startEvent.tick) / (tickrate * duration), 0, 1) : 0;
            ctx.fillStyle = 'rgba(8,12,16,.82)';
            ctx.fillRect(x - 22, y - 28, 44, 5);
            ctx.fillStyle = player.defusing ? '#8fd8ff' : '#ffbd70';
            ctx.fillRect(x - 21, y - 27, 42 * progress, 3);
            ctx.fillStyle = '#f8fafc';
            ctx.font = '700 8px Segoe UI';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(
              `${player.defusing ? 'DEFUSE' : 'PLANT'} ${Math.max(0, duration - (tick - (startEvent?.tick ?? tick)) / tickrate).toFixed(1)}s`,
              x,
              y - 30,
            );
          }
          const damage = damageState.current.get(player.id);
          const popupAge = damage ? now - damage.started : Infinity;
          const showDamage = Boolean(damage?.damage && popupAge < 800);
          ctx.fillStyle = '#111419';
          ctx.textAlign = 'center';
          const healthLabel = String(health);
          const healthSize =
            healthLabel.length >= 3 ? 7 : healthLabel.length === 2 ? 8 : 9;
          ctx.font = `bold ${healthSize}px Segoe UI`;
          ctx.fillText(healthLabel, x, y + 3);
          if (showDamage) {
            const damageLabel = `-${damage!.damage}`;
            const damageSize = damageLabel.length >= 4 ? 7 : 8;
            ctx.fillStyle = '#ff8e96';
            ctx.font = `bold ${damageSize}px Segoe UI`;
            ctx.globalAlpha = Math.max(0, 1 - popupAge / 800);
            ctx.fillText(damageLabel, x, y - 11 - popupAge / 100);
            ctx.globalAlpha = player.alive ? 1 : 0.4;
          }
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
  }, [
    detail,
    round,
    clock,
    tickrate,
    lower,
    selected,
    copiedGrenadeId,
    imagePath,
    trajectoryMovementTicks,
    smokeTimeline,
    killEvents,
    killTicks,
    explosionEvents,
    bombEvents,
    grenadeById,
    fireGrenades,
  ]);
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
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;
            const grenade = findGrenadeAt(x, y);
            if (grenade) onSelect(grenade);
          }
          drag.current = null;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const grenade = findGrenadeAt(e.clientX - r.left, e.clientY - r.top);
          if (grenade) onCopyCoordinates(grenade);
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
      <div className="map-toolbar-floating replay-map-tools">
        <button
          aria-label={tr('Zoom in', 'Приблизить')}
          data-tip={tr('Zoom in', 'Приблизить')}
          onClick={() => zoomAt(1.18)}
        >
          <Plus size={16} />
        </button>
        <button
          aria-label={tr('Zoom out', 'Отдалить')}
          data-tip={tr('Zoom out', 'Отдалить')}
          onClick={() => zoomAt(1 / 1.18)}
        >
          <Minus size={16} />
        </button>
        <button
          className="reset"
          aria-label={tr('Reset view', 'Сбросить вид')}
          data-tip={tr('Reset view', 'Сбросить вид')}
          onClick={() => setView({ s: 1, x: 0, y: 0 })}
        >
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  );
}
