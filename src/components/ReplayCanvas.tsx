import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import c4Icon from '../assets/equipment_icons/c4.svg';
import { preloadImage, cachedImage } from '../lib/imageCache';
import {
  activeSmokes,
  buildSmokeTimeline,
  clamp,
  framePair,
  interpolatePlayer,
  playerBombAction,
  playersAt,
} from '../lib/replayPlayback';
import { onReplayAnimationFrame } from '../lib/replayAnimation';
import { weaponIcon } from '../lib/weaponIcons';
import {
  replayGrenadeIcon,
  replayGrenadeColors as colors,
} from '../lib/replayGrenadeIcons';
import { drawReplayInfernos } from '../lib/replayInferno';
import ReplayAnnotations from './ReplayAnnotations';
import { useI18n } from '../i18n';
import type {
  ReplayDetail,
  ReplayFrame,
  ReplayGrenade,
  ReplayRound,
} from '../types/replay';

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
  onPause: () => void;
  onSeekNote: (tick: number, lower: boolean) => void;
  showNotesControls?: boolean;
  notesControlsTarget?: HTMLElement | null;
};
const FLASH_FULL_RADIUS_GAME = 400;
const FLASH_FADE_RADIUS_GAME = 1000;
const FLASH_EFFECT_SECONDS = 0.6;
const HE_RADIUS_GAME = 400;
// Keep the HE burst close to Nadegrid's fast fire-core animation.
const HE_EFFECT_SECONDS = 0.82;
// Keep the replay blast diameter in sync with Nadegrid.  These values are
// expressed in the same world units as the radar projection, so the effect
// stays anchored to the actual planted C4 position at every zoom level.
const BOMB_RADII_GAME: Record<string, number> = {
  de_nuke: 2275,
  de_dust2: 2450,
  de_mirage: 2275,
  de_inferno: 2100,
  de_train: 1750,
  de_ancient: 2275,
  de_cache: 2100,
  de_anubis: 1575,
  de_overpass: 2275,
  de_vertigo: 1750,
};
const BOMB_SHOCKWAVE_SECONDS = 0.9;
const BOMB_CORE_SECONDS = 0.7;
const BOMB_EFFECT_SECONDS = 1.5;
const TRAJECTORY_FADE_SECONDS = 0.9;
const SMOKE_RADIUS_GAME = 144;
const SMOKE_SIDE_COLORS: Record<string, string> = {
  T: '#fb923c',
  CT: '#38bdf8',
};
function lowerBoundTick(events: ReplayRound['events'], tick: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type WeaponEffect = 'firearm' | 'knife' | 'zeus' | 'none';

function weaponEffect(name: unknown): WeaponEffect {
  const weapon = String(name ?? '')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .trim();
  if (
    /knife|bayonet|karambit|kukri|talon|butterfly|flip|gut|huntsman|falchion|shadow daggers|navaja|stiletto|ursus|nomad|paracord|survival/.test(
      weapon,
    )
  )
    return 'knife';
  if (/taser|zeus/.test(weapon)) return 'zeus';
  if (/grenade|flashbang|smoke|molotov|incendiary|decoy|c4|bomb/.test(weapon))
    return 'none';
  return 'firearm';
}

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
  onPause,
  onSeekNote,
  showNotesControls = true,
  notesControlsTarget,
}: Props) {
  const { tr } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [failedImagePath, setFailedImagePath] = useState<string | null>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const clampView = useCallback((s: number, x: number, y: number) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (s <= 1 || !bounds?.width || !bounds.height) return { s: 1, x: 0, y: 0 };
    const maxX = (bounds.width * (s - 1)) / 2;
    const maxY = (bounds.height * (s - 1)) / 2;
    return { s, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);
  const zoomAt = useCallback(
    (factor: number, x = 0, y = 0) => {
      setView((current) => {
        const s = clamp(current.s * factor, 1, 6);
        const ratio = s / current.s;
        return clampView(
          s,
          x - (x - current.x) * ratio,
          y - (y - current.y) * ratio,
        );
      });
    },
    [clampView],
  );
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (
        !event.deltaY ||
        !(event.target instanceof Element) ||
        !event.target.closest('canvas, .replay-annotations')
      )
        return;
      event.preventDefault();
      const bounds = canvas.current?.getBoundingClientRect();
      if (!bounds) return;
      zoomAt(
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
        event.clientX - bounds.left - bounds.width / 2,
        event.clientY - bounds.top - bounds.height / 2,
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoomAt]);
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
  const bombEvents = useMemo(() => {
    const seen = new Set<string>();
    return round.events.filter((event) => {
      if (
        event.type !== 'bomb_exploded' ||
        event.x === null ||
        event.y === null
      )
        return false;
      // Some replay streams can contain the detonation callback twice at
      // different ticks. There is only one C4 explosion per round, so the
      // round itself is the identity of the visual effect.
      const key = String(event.round_number);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [round]);
  const grenadeById = useMemo(
    () => new Map(round.grenades.map((grenade) => [grenade.id, grenade])),
    [round],
  );
  const weaponFireEvents = useMemo(
    () => round.events.filter((event) => event.type === 'weapon_fire'),
    [round],
  );
  const hitEvents = useMemo(
    () =>
      round.events.filter((event) =>
        ['damage', 'bullet_damage', 'kill'].includes(event.type),
      ),
    [round],
  );
  const actionEventsByPlayer = useMemo(() => {
    const actions = new Map<string, ReplayRound['events']>();
    for (const event of round.events) {
      if (
        event.type !== 'bomb_plant_begin' &&
        event.type !== 'bomb_defuse_start' &&
        event.type !== 'bomb_planted' &&
        event.type !== 'bomb_defused'
      )
        continue;
      if (!event.player_id) continue;
      const list = actions.get(event.player_id) ?? [];
      list.push(event);
      actions.set(event.player_id, list);
    }
    return actions;
  }, [round]);
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
        (point) =>
          [point[0], point[1], point[2] ?? 0] as [number, number, number],
      );
    }
    return tracks;
  }, [round, detail.radar, detail.map.has_lower_radar, lower]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });
    if (!ctx) return;
    let image = cachedImage(imagePath);
    const bombImage = new Image();
    const weaponImages = new Map<string, HTMLImageElement>();
    const grenadeImages = new Map<string, HTMLImageElement>();
    for (const type of [
      'smoke',
      'flash',
      'HE',
      'molotov',
      'incendiary grenade',
      'decoy',
    ]) {
      const src = replayGrenadeIcon(type);
      if (!src) continue;
      const icon = new Image();
      icon.onload = () => {
        if (!disposed) draw();
      };
      icon.src = src;
      grenadeImages.set(src, icon);
    }
    bombImage.onload = draw;
    bombImage.src = c4Icon;
    let imageReady = false,
      disposed = false;
    const smokeTimerWidths = new Map<boolean, number>();
    const nameplates = new Map<
      string,
      {
        image: HTMLCanvasElement;
        label: string;
        width: number;
      }
    >();
    // Canvas does not repaint when a web font finishes loading while paused.
    void document.fonts
      .load('600 100px Orbitron', '0123456789.s')
      .then(() => {
        if (disposed) return;
        smokeTimerWidths.clear();
        draw();
      })
      .catch(() => undefined);
    setFailedImagePath(null);
    if (image?.complete && image.naturalWidth > 0) {
      imageReady = true;
    } else if (imagePath) {
      void preloadImage(imagePath)
        .then((loaded) => {
          if (disposed || !loaded) return;
          image = loaded;
          imageReady = true;
          draw();
        })
        .catch(() => {
          if (!disposed) setFailedImagePath(imagePath);
        });
    }
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
      // Replay effects use several gradients and shadows per frame. Capping
      // the backing store keeps high-DPI Windows displays from rendering
      // four times as many pixels without changing the CSS-sized map.
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      nameplates.clear();
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
      const drawPlayerName = (
        player: ReplayFrame['players'][number],
        x: number,
        y: number,
        alpha: number,
      ) => {
        const name = player.name.trim() || 'Unknown';
        const teamColor = player.side === 'CT' ? '#8dbdff' : '#ff986b';
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = '600 10px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const key = `${player.side}:${name}`;
        let plate = nameplates.get(key);
        if (!plate) {
          const maxWidth = 132;
          let label = name;
          if (ctx.measureText(label).width > maxWidth) {
            while (
              label.length > 3 &&
              ctx.measureText(`${label}…`).width > maxWidth
            )
              label = label.slice(0, -1);
            label += '…';
          }
          const width = Math.min(
            maxWidth + 12,
            ctx.measureText(label).width + 16,
          );
          const image = document.createElement('canvas');
          image.width = Math.ceil((width + 16) * dpr);
          image.height = Math.ceil(32 * dpr);
          const background = image.getContext('2d')!;
          background.scale(dpr, dpr);
          background.shadowColor = 'rgba(0,0,0,.45)';
          background.shadowBlur = 5 * dpr;
          background.fillStyle = 'rgba(8, 11, 15, .76)';
          background.beginPath();
          background.roundRect(8, 8, width, 16, 5);
          background.fill();
          background.shadowBlur = 0;
          background.fillStyle = teamColor;
          background.beginPath();
          background.roundRect(11, 12, 2, 8, 1);
          background.fill();
          plate = { image, label, width };
          nameplates.set(key, plate);
        }
        const top = y + 15;
        ctx.drawImage(
          plate.image,
          x - plate.width / 2 - 8,
          top - 8,
          plate.width + 16,
          32,
        );
        ctx.fillStyle = '#f4f6f8';
        ctx.fillText(plate.label, x, top + 8);
        ctx.restore();
      };
      const visible = (z: number) =>
        radar!.split_z === null ||
        !detail.map.has_lower_radar ||
        (lower ? z < radar!.split_z : z >= radar!.split_z);
      if (imageReady && image)
        ctx.drawImage(image, ox, oy, 1024 * unit, 1024 * unit);
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
      const replayPlayers = playersAt(
        round,
        tick,
        killEvents,
        killTicks,
        frame,
      );
      // Dead players belong to the lowest replay layer: draw their marker and
      // name before utility, bomb, tracer, and live-player overlays.
      for (const raw of replayPlayers) {
        if (raw.alive || !visible(raw.z)) continue;
        const player = interpolatePlayer(raw, nextPlayers.get(raw.id), t);
        const [x, y] = point(player.x, player.y);
        const color = player.side === 'CT' ? '#8dbdff' : '#ff986b';
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
        drawPlayerName(player, x, y, 0.4);
        ctx.restore();
      }
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
      drawReplayInfernos(ctx, frame.infernos ?? [], point, visible, now);
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
          if (age < 0 || age > BOMB_EFFECT_SECONDS) continue;
          const [x, y] = point(event.x!, event.y!);
          const mapKey = String(detail.map.name ?? '')
            .toLowerCase()
            .startsWith('de_')
            ? String(detail.map.name).toLowerCase()
            : `de_${String(detail.map.name ?? '').toLowerCase()}`;
          const fullRadius = Math.max(
            16,
            ((BOMB_RADII_GAME[mapKey] ?? 2275) / radar!.scale) * unit,
          );
          const shockProgress = clamp(age / BOMB_SHOCKWAVE_SECONDS, 0, 1);
          const coreProgress = clamp(age / BOMB_CORE_SECONDS, 0, 1);

          // Nadegrid's shockwave keyframes: the ring expands almost
          // immediately, holds at the blast radius, then fades away.
          // Keep the ring on the same single pulse as the fireball.  A
          // delayed opacity ramp makes the ring look like a second flash
          // when the canvas is sampled at replay frame boundaries.
          const shockScale = 0.05 + (1 - Math.pow(1 - shockProgress, 3)) * 0.95;
          const shockOpacity = 0.9 * (1 - shockProgress);

          // Nadegrid's bright core grows faster than the outer ring and uses
          // the same warm white/orange fireball gradient.
          const coreScale = 0.05 + (1 - Math.pow(1 - coreProgress, 2)) * 0.95;
          const coreOpacity = 1 - coreProgress;

          ctx.save();
          const ringRadius = fullRadius * shockScale;
          ctx.globalAlpha = shockOpacity;
          const ringGradient = ctx.createRadialGradient(
            x,
            y,
            ringRadius * 0.58,
            x,
            y,
            ringRadius,
          );
          ringGradient.addColorStop(0, 'rgba(255,150,50,0)');
          ringGradient.addColorStop(0.72, 'rgba(255,150,50,0.22)');
          ringGradient.addColorStop(0.85, 'rgba(200,70,20,0.12)');
          ringGradient.addColorStop(1, 'rgba(255,150,50,0)');
          ctx.fillStyle = ringGradient;
          ctx.beginPath();
          ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,180,70,0.9)';
          ctx.lineWidth = 3;
          ctx.shadowColor = 'rgba(255,130,30,0.7)';
          ctx.shadowBlur = 16;
          ctx.beginPath();
          ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
          ctx.stroke();

          const coreRadius = fullRadius * coreScale;
          const coreGradient = ctx.createRadialGradient(
            x,
            y,
            0,
            x,
            y,
            coreRadius,
          );
          coreGradient.addColorStop(
            0,
            `rgba(255,245,205,${0.98 * coreOpacity})`,
          );
          coreGradient.addColorStop(
            0.08,
            `rgba(255,190,80,${0.92 * coreOpacity})`,
          );
          coreGradient.addColorStop(
            0.2,
            `rgba(255,110,30,${0.75 * coreOpacity})`,
          );
          coreGradient.addColorStop(
            0.36,
            `rgba(170,45,15,${0.45 * coreOpacity})`,
          );
          coreGradient.addColorStop(0.62, 'rgba(170,45,15,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = coreGradient;
          ctx.shadowColor = 'rgba(255,120,20,0.8)';
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.arc(x, y, coreRadius, 0, Math.PI * 2);
          ctx.fill();
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
        // The replay keeps the full throw path visible. Sample very dense
        // paths so large demos do not spend a frame on hundreds of redundant
        // line segments.
        const pointCount = trajectory.points.length;
        const stride = pointCount > 180 ? 3 : pointCount > 90 ? 2 : 1;
        for (
          let pointIndex = 0;
          pointIndex < pointCount;
          pointIndex += stride
        ) {
          const p = trajectory.points[pointIndex];
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
        const type = grenade?.data.grenade_type ?? projectile.type;
        const src = replayGrenadeIcon(type);
        const icon = src ? grenadeImages.get(src) : undefined;
        ctx.save();
        ctx.shadowColor = '#080b0f';
        ctx.shadowBlur = 4;
        if (icon?.complete && icon.naturalWidth > 0) {
          const scale = 19 / Math.max(icon.naturalWidth, icon.naturalHeight);
          const w = icon.naturalWidth * scale,
            h = icon.naturalHeight * scale;
          ctx.drawImage(icon, x - w / 2, y - h / 2, w, h);
        } else {
          // Keep the projectile identifiable while its SVG is loading.
          ctx.fillStyle = colors[type] ?? '#f4f6f8';
          ctx.font = 'bold 12px Segoe UI';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(type.slice(0, 1).toUpperCase() || '?', x, y);
        }
        ctx.restore();
        if (grenade) hits.current.push({ x, y, g: grenade });
      }
      // Draw smoke timers after projectiles so the moving grenade point cannot
      // cover the remaining-time label in the center of the cloud.
      for (const smoke of visibleSmokes) {
        const [x, y] = point(smoke.x, smoke.y);
        const radius = (SMOKE_RADIUS_GAME / radar.scale) * unit;
        ctx.save();
        // Fit the countdown inside the cloud without resizing it as digits change.
        const compact = radius < 18;
        let referenceWidth = smokeTimerWidths.get(compact);
        if (referenceWidth === undefined) {
          ctx.font = '600 100px Orbitron, "Segoe UI", sans-serif';
          referenceWidth = ctx.measureText(compact ? '00' : '00.0s').width;
          smokeTimerWidths.set(compact, referenceWidth);
        }
        const fontSize = Math.min(
          clamp(radius * 0.7, 8, 26),
          (radius * 1.7 * 100) / referenceWidth,
        );
        const label = compact
          ? String(Math.ceil(smoke.remainingSeconds))
          : `${smoke.remainingSeconds.toFixed(1)}s`;
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = 'rgba(2,6,23,0.85)';
        ctx.lineWidth = clamp(fontSize * 0.12, 1, 2.5);
        ctx.lineJoin = 'round';
        ctx.font = `600 ${fontSize}px Orbitron, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeText(label, x, y);
        ctx.fillText(label, x, y);
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
      const playerById = new Map(
        frame.players.map((player) => [player.id, player]),
      );
      const tracerAge = (event: ReplayRound['events'][number]) =>
        tick - event.tick;
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
          // The SVG version in Nadegrid animates the 9..46px segment forward
          // by 160px over 100ms. Reproduce that travel in canvas space.
          const shotProgress = Math.min(1, age / Math.max(1, tickrate * 0.1));
          const travel = 160 * shotProgress;
          const fromOffset = 9 + travel;
          const toOffset = 46 + travel;
          end = [
            start[0] + directionX * toOffset,
            start[1] + directionY * toOffset,
          ];
          start[0] += directionX * fromOffset;
          start[1] += directionY * fromOffset;
        }
        const color = shooter.side === 'CT' ? '#38bdf8' : '#fb923c';
        const opacity = Math.max(0.12, 1 - age / Math.max(1, windowTicks));
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.strokeStyle = color;
        ctx.lineWidth =
          hit && ['damage', 'bullet_damage', 'kill'].includes(event.type)
            ? 4
            : 1.5;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = hit ? 12 : 10;
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
      const drawSpecialEffect = (
        event: ReplayRound['events'][number],
        shooter: ReplayFrame['players'][number],
        target: { x: number; y: number } | null,
        effect: 'knife' | 'zeus',
        windowTicks: number,
      ) => {
        const age = tracerAge(event);
        if (age < 0 || age > windowTicks || !visible(shooter.z)) return;
        const start = point(shooter.x, shooter.y);
        const rawYaw = Number(event.data?.yaw ?? shooter.yaw);
        const angle = (-rawYaw * Math.PI) / 180;
        const progress = Math.min(1, age / Math.max(1, windowTicks));
        const color = effect === 'zeus' ? '#f8e16c' : '#e7edf5';
        ctx.save();
        ctx.globalAlpha = Math.max(0.12, 1 - progress);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = effect === 'zeus' ? 15 : 9;
        if (effect === 'knife') {
          // Keep the knife readable as a small held blade, with only a
          // restrained slash arc to communicate the swing.
          // The in-game knife animation rocks the blade across the view. Use
          // the event lifetime to reproduce that short left-right movement.
          const swingAngle = angle + Math.sin(progress * Math.PI * 2) * 0.72;
          const ux = Math.cos(swingAngle);
          const uy = Math.sin(swingAngle);
          const px = -uy;
          const py = ux;
          const handleStart = 7;
          const bladeStart = 12;
          const bladeEnd = 28 + progress * 7;
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = Math.max(0.2, 1 - progress);
          ctx.shadowBlur = 5;
          ctx.strokeStyle = '#252b33';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(start[0] + ux * handleStart, start[1] + uy * handleStart);
          ctx.lineTo(start[0] + ux * bladeStart, start[1] + uy * bladeStart);
          ctx.stroke();
          ctx.fillStyle = '#e8eef5';
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(
            start[0] + ux * bladeStart + px * 2.2,
            start[1] + uy * bladeStart + py * 2.2,
          );
          ctx.lineTo(
            start[0] + ux * (bladeEnd - 4) + px * 2.2,
            start[1] + uy * (bladeEnd - 4) + py * 2.2,
          );
          ctx.lineTo(start[0] + ux * bladeEnd, start[1] + uy * bladeEnd);
          ctx.lineTo(
            start[0] + ux * (bladeEnd - 4) - px * 1.2,
            start[1] + uy * (bladeEnd - 4) - py * 1.2,
          );
          ctx.lineTo(
            start[0] + ux * bladeStart - px * 1.2,
            start[1] + uy * bladeStart - py * 1.2,
          );
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const end = target
            ? point(target.x, target.y)
            : ([
                start[0] + Math.cos(angle) * (36 + progress * 20),
                start[1] + Math.sin(angle) * (36 + progress * 20),
              ] as [number, number]);
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(
            start[0] + Math.cos(angle) * 8,
            start[1] + Math.sin(angle) * 8,
          );
          ctx.lineTo(end[0], end[1]);
          ctx.stroke();
          for (const offset of [-0.28, 0.28]) {
            ctx.beginPath();
            ctx.moveTo(
              start[0] + Math.cos(angle + offset) * 8,
              start[1] + Math.sin(angle + offset) * 8,
            );
            ctx.lineTo(
              end[0] + Math.cos(angle + offset) * 8,
              end[1] + Math.sin(angle + offset) * 8,
            );
            ctx.stroke();
          }
          if (target) {
            ctx.beginPath();
            ctx.arc(end[0], end[1], 5 + progress * 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      };
      const fireWindow = Math.max(3, Math.round(tickrate * 0.14));
      const fireStart = lowerBoundTick(weaponFireEvents, tick - fireWindow);
      for (
        let eventIndex = fireStart;
        eventIndex < weaponFireEvents.length;
        eventIndex += 1
      ) {
        const event = weaponFireEvents[eventIndex];
        if (event.tick > tick) break;
        const shooter = event.player_id
          ? playerById.get(event.player_id)
          : undefined;
        if (!shooter) continue;
        const effect = weaponEffect(event.data?.weapon);
        if (effect === 'firearm')
          drawTracer(event, shooter, null, false, fireWindow);
        else if (effect === 'knife' || effect === 'zeus')
          drawSpecialEffect(event, shooter, null, effect, fireWindow);
      }
      const hitWindow = Math.max(3, Math.round(tickrate * 0.28));
      const hitStart = lowerBoundTick(hitEvents, tick - hitWindow);
      for (
        let eventIndex = hitStart;
        eventIndex < hitEvents.length;
        eventIndex += 1
      ) {
        const event = hitEvents[eventIndex];
        if (event.tick > tick) break;
        const shooter = event.player_id
          ? playerById.get(event.player_id)
          : undefined;
        if (!shooter) continue;
        const effect = weaponEffect(event.data?.weapon);
        if (effect === 'none') continue;
        const victim = event.target_id
          ? playerById.get(event.target_id)
          : undefined;
        const target = victim
          ? { x: victim.x, y: victim.y }
          : typeof event.x === 'number' && typeof event.y === 'number'
            ? { x: event.x, y: event.y }
            : null;
        if (effect === 'firearm')
          drawTracer(event, shooter, target, true, hitWindow);
        else if (effect === 'knife' || effect === 'zeus')
          drawSpecialEffect(event, shooter, target, effect, hitWindow);
      }
      // Draw dead players first so their dim markers and names stay beneath
      // live players when the two labels overlap.
      replayPlayers
        .filter((player) => player.alive)
        .forEach((raw) => {
          const player = interpolatePlayer(raw, nextPlayers.get(raw.id), t);
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
            // Nadegrid keeps the team-colored player base and paints the blind
            // indicator as a clipped white conic sector over the circle.
            if (player.flashed) {
              ctx.shadowColor = 'rgba(251,191,36,0.55)';
              ctx.shadowBlur = 10;
            }
            ctx.fillStyle = color;
            ctx.strokeStyle = '#101419';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            // Show the item currently held by the player, matching the compact
            // weapon badge used by Nadegrid. Keep it outside the player circle
            // so it remains readable without changing the player marker size.
            const activeName = String(player.active_weapon ?? '').trim();
            const activeImage = activeWeaponImage(activeName);
            if (activeImage?.complete && activeImage.naturalWidth > 0) {
              const activeLower = activeName.toLowerCase();
              const utility =
                activeLower.includes('grenade') ||
                activeLower.includes('flashbang') ||
                activeLower.includes('smoke') ||
                activeLower.includes('molotov') ||
                activeLower.includes('incendiary') ||
                activeLower.includes('decoy') ||
                activeLower.includes('knife') ||
                activeLower === 'c4' ||
                activeLower.includes('bomb');
              const maxWidth = utility ? 16 : 25;
              const maxHeight = utility ? 16 : 13;
              const scale = Math.min(
                maxWidth / Math.max(1, activeImage.naturalWidth),
                maxHeight / Math.max(1, activeImage.naturalHeight),
              );
              const iconWidth = activeImage.naturalWidth * scale;
              const iconHeight = activeImage.naturalHeight * scale;
              ctx.save();
              ctx.globalAlpha = player.alive ? 0.94 : 0.45;
              ctx.shadowColor = '#05070a';
              ctx.shadowBlur = 3;
              ctx.shadowOffsetY = 1;
              ctx.drawImage(
                activeImage,
                x + 11,
                y - iconHeight / 2,
                iconWidth,
                iconHeight,
              );
              ctx.restore();
            }
            // Keep the carried C4 on the player's left side. The badge sits
            // outside the marker, leaving the HP value in the centre and the
            // active weapon icon on the right unobstructed.
            if (
              frame.bomb?.state === 'carried' &&
              frame.bomb.carrier_id === player.id
            ) {
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
              const flashArcDegrees = Math.min(
                180,
                Math.max(5, flashProgress * 180),
              );
              const flashArc = (flashArcDegrees * Math.PI) / 180;
              // CSS conic-gradient(180deg - arc/2) in Nadegrid points down
              // because CSS angles start at 12 o'clock. Convert that exact
              // angle to canvas coordinates and clip the sector to the marker.
              const flashStart = Math.PI / 2 - flashArc * 0.5;
              const flashRadius = 8;
              ctx.save();
              ctx.globalAlpha = 0.88;
              ctx.fillStyle = 'rgba(255,255,255,0.88)';
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.arc(x, y, flashRadius, flashStart, flashStart + flashArc);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
            const action = playerBombAction(
              player,
              tick,
              tickrate,
              actionEventsByPlayer.get(player.id) ?? [],
            );
            if (action) {
              ctx.fillStyle = 'rgba(8,12,16,.82)';
              ctx.fillRect(x - 22, y - 28, 44, 5);
              ctx.fillStyle = action.defusing ? '#8fd8ff' : '#ffbd70';
              ctx.fillRect(x - 21, y - 27, 42 * action.progress, 3);
              ctx.fillStyle = '#f8fafc';
              ctx.font = '700 8px Segoe UI';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ctx.fillText(
                `${action.label} ${action.remaining.toFixed(1)}s`,
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
          }
          drawPlayerName(player, x, y, player.alive ? 1 : 0.4);
          ctx.globalAlpha = 1;
        });
    }
    const unlisten = onReplayAnimationFrame(draw);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => {
      disposed = true;
      observer.disconnect();
      unlisten();
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
    actionEventsByPlayer,
  ]);
  return (
    <div
      ref={surface}
      className={`replay-map ${view.s > 1 ? 'is-draggable' : ''}`}
    >
      <canvas
        ref={canvas}
        aria-label={tr('Match radar', 'Радар матча')}
        role="img"
        tabIndex={0}
        onKeyDown={(e) => {
          if (['+', '=', '-', '_', '0', 'Home'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === '+' || e.key === '=') zoomAt(1.18);
            else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.18);
            else if (e.key === '0' || e.key === 'Home')
              setView({ s: 1, x: 0, y: 0 });
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
      <ReplayAnnotations
        key={`${detail.id}.${detail.metadata.parsed_at}`}
        detail={detail}
        round={round}
        clock={clock}
        lower={lower}
        showControls={showNotesControls}
        controlsTarget={notesControlsTarget}
        view={view}
        onPause={onPause}
        onSeek={onSeekNote}
      />
      {(!imagePath || !detail.radar || failedImagePath === imagePath) && (
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
