import type { ReplayFrame } from '../types/replay';

// NadeGrid's flame silhouettes and palette, rendered in the replay canvas.
const flame = new Path2D('M 0 -16 C 10 -6 9 7 0 9 C -9 6 -7 -7 0 -16 Z');
const mid = new Path2D('M 1 -11 C 7 -3 5 6 0 7 C -5 4 -3 -4 1 -11 Z');
const core = new Path2D('M 0 -6 C 3 -1 2 4 0 5 C -3 3 -2 -2 0 -6 Z');
const wisp = new Path2D('M -7 -3 C -12 -15 8 -17 3 -30');
const wave = (time: number, duration: number) =>
  (1 - Math.cos((time / duration) * Math.PI)) / 2;
const layers = [
  [flame, 860, 'rgba(249,115,22,.76)', '#f97316', false],
  [mid, 680, 'rgba(251,191,36,.88)', '#fb923c', true],
  [core, 520, 'rgba(255,247,237,.92)', '#fbbf24', false],
] as const;
const spriteSize = 64;
let sprites: HTMLCanvasElement[] | undefined;

function fireSprites() {
  if (sprites) return sprites;
  // Blurring each flame on every frame saturates WebView2's raster thread.
  // Cache the glow with the shape; only transform and fade the small texture.
  sprites = Array.from({ length: 6 }, (_, index) => {
    const image = document.createElement('canvas');
    image.width = image.height = spriteSize * 2;
    const ctx = image.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.translate(spriteSize / 2, spriteSize / 2);
    if (index < 3) {
      const [path, , color, glow] = layers[index];
      ctx.fillStyle = color;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 12;
      ctx.fill(path);
    } else if (index < 5) {
      const heat = index === 3;
      ctx.fillStyle = heat ? 'rgba(127,29,29,.38)' : 'rgba(127,29,29,.64)';
      ctx.shadowColor = heat ? 'rgba(127,29,29,.5)' : 'rgba(185,28,28,.82)';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.ellipse(
        0,
        heat ? 1 : 2,
        heat ? 15 : 10.5,
        heat ? 10 : 7.5,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else {
      ctx.fillStyle = '#fed7aa';
      ctx.shadowColor = '#fb923c';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    return image;
  });
  return sprites;
}

function drawSprite(ctx: CanvasRenderingContext2D, image: HTMLCanvasElement) {
  ctx.drawImage(
    image,
    -spriteSize / 2,
    -spriteSize / 2,
    spriteSize,
    spriteSize,
  );
}

export function drawReplayInfernos(
  ctx: CanvasRenderingContext2D,
  infernos: ReplayFrame['infernos'],
  point: (x: number, y: number) => [number, number],
  visible: (z: number) => boolean,
  now: number,
) {
  for (const inferno of infernos) {
    const fires = inferno.fires.filter(
      (fire) => fire.burning && visible(fire.z),
    );
    if (!fires.length) continue;
    const images = fireSprites();
    if (inferno.hull.length >= 3) {
      ctx.save();
      ctx.beginPath();
      inferno.hull.forEach((p, i) => {
        const [x, y] = point(p.x, p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.55 + wave(now, 1075) * 0.41;
      ctx.fillStyle = 'rgba(248,113,22,.09)';
      ctx.strokeStyle = 'rgba(251,146,60,.28)';
      ctx.lineWidth = 8;
      ctx.shadowColor = 'rgba(239,68,68,.5)';
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(127,29,29,.2)';
      ctx.strokeStyle = 'rgba(251,146,60,.46)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 4]);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    fires.forEach((fire, index) => {
      const [x, y] = point(fire.x, fire.y);
      const time = now - (index % 5) * 160;
      const spread = 0.82 + ((index * 37) % 24) / 100;
      const tilt = ((((index * 53) % 46) - 23) * Math.PI) / 180;
      ctx.save();
      ctx.translate(x, y);
      const heat = wave(time, 1650);
      ctx.save();
      ctx.scale(spread * (0.86 + heat * 0.3), 0.72 + heat * 0.32);
      ctx.globalAlpha = 0.42 + heat * 0.36;
      drawSprite(ctx, images[3]);
      ctx.restore();

      const smoke = (((time % 2400) + 2400) % 2400) / 2400;
      ctx.save();
      ctx.globalAlpha = Math.sin(smoke * Math.PI) * 0.32;
      ctx.translate(0, 6 - smoke * 24);
      ctx.scale(0.72 + smoke * 0.52, 0.72 + smoke * 0.52);
      ctx.strokeStyle = 'rgba(30,41,59,.34)';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.stroke(wisp);
      ctx.restore();

      const ground = wave(time, 1060);
      ctx.save();
      ctx.scale(spread * (0.86 + ground * 0.34), 0.78 + ground * 0.24);
      ctx.globalAlpha = 0.55 + ground * 0.27;
      drawSprite(ctx, images[4]);
      ctx.restore();

      for (const [
        layerIndex,
        [, duration, color, , reverse],
      ] of layers.entries()) {
        const phase = wave(time, duration);
        const flicker = reverse ? 1 - phase : phase;
        ctx.save();
        ctx.translate(0, 3 - flicker * 7);
        ctx.rotate(tilt * (1 - flicker * 1.45));
        ctx.scale(0.82 + flicker * 0.23, 0.72 + flicker * 0.62);
        ctx.globalAlpha = 0.62 + flicker * 0.34;
        ctx.fillStyle = color;
        drawSprite(ctx, images[layerIndex]);
        ctx.restore();
      }
      const ember = (((time % 1350) + 1350) % 1350) / 1350;
      ctx.globalAlpha = Math.sin(ember * Math.PI) * 0.9;
      ctx.translate(
        ((index * 29) % 13) - 6 + ember * 5,
        -5 - ((index * 17) % 10) + 7 - ember * 25,
      );
      const emberRadius = 1.35 * (0.55 - ember * 0.35);
      ctx.scale(emberRadius, emberRadius);
      drawSprite(ctx, images[5]);
      ctx.restore();
    });
  }
}
