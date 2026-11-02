// Browser regression with deterministic fixtures and mocked native IPC.
// Optional real parser output: node tests/replay-ui.mjs <playwright directory> <NDJSON>
/* global window, document, localStorage, console */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import { createServer } from 'vite';
import * as fixture from './fixtures/replay.mjs';

const { chromium } = await import(
  process.argv[2]
    ? pathToFileURL(process.argv[2] + '/index.mjs').href
    : 'playwright'
);
const records = process.argv[3]
  ? (await readFile(process.argv[3], 'utf8')).trim().split('\n').map(JSON.parse)
  : null;
const metadata =
  records?.find((r) => r.type === 'complete') ?? fixture.metadata;
const resolvedRound = records?.find(
  (r) =>
    r.type === 'round' &&
    r.events.some((e) => ['bomb_defused', 'bomb_exploded'].includes(e.type)),
);
const testRoundNumbers = new Set([0, 1, 2, resolvedRound?.round_number ?? 3]);
const rounds = records
  ? records
      .filter((r) => r.type === 'round' && testRoundNumbers.has(r.round_number))
      .map((r) => ({
        ...r,
        grenades: [],
      }))
  : fixture.rounds;
for (const record of (records ?? []).filter((r) => r.type === 'grenade')) {
  const round = rounds.find((r) => r.round_number === record.round_number);
  if (!round) continue;
  round.grenades.push(record.grenade);
  round.events.push(...record.events);
}
for (const round of rounds) round.events.sort((a, b) => a.tick - b.tick);
const first = rounds.find((r) => r.round_number === 1) ?? rounds[0];
const mapKey = metadata.map.toLowerCase().replace(/^de_/, '');
const mapImagePath =
  '/@fs/' +
  fileURLToPath(
    new URL(
      `../src-tauri/resources/maps/2d/de_${mapKey}_radar_psd.png`,
      import.meta.url,
    ),
  ).replaceAll('\\', '/');
const radarConfig = await readFile(
  new URL(
    `../src-tauri/resources/radar_configs/de_${mapKey}.txt`,
    import.meta.url,
  ),
  'utf8',
);
const radar = Object.fromEntries(
  ['pos_x', 'pos_y', 'scale'].map((key) => [
    key,
    Number(radarConfig.match(new RegExp(`"${key}"\\s+"([^" ]+)"`))[1]),
  ]),
);
radar.split_z = null;
const server = await createServer({ server: { port: 1428, strictPort: true } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.NADE_VIEWER_TEST_BROWSER_PATH,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await context.addInitScript(
    ({ metadata, rounds, mapImagePath, radar }) => {
      localStorage.setItem('nadeviewer.locale', 'ru');
      Object.defineProperty(window.navigator, 'clipboard', {
        value: {
          async writeText(text) {
            window.__copiedReplayCoordinates = text;
          },
        },
      });
      const drawImage = window.CanvasRenderingContext2D.prototype.drawImage;
      const clearRect = window.CanvasRenderingContext2D.prototype.clearRect;
      window.CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        window.__replayActionLabels = [];
        window.__replayGrenadeIcons = [];
        window.__replayFlameLayers = [];
        return clearRect.apply(this, args);
      };
      const fill = window.CanvasRenderingContext2D.prototype.fill;
      window.CanvasRenderingContext2D.prototype.fill = function (...args) {
        if (args[0] instanceof window.Path2D) {
          const transform = this.getTransform();
          window.__replayFlameLayers.push({
            color: this.fillStyle,
            alpha: this.globalAlpha,
            a: transform.a,
            d: transform.d,
          });
        }
        return fill.apply(this, args);
      };
      const fillText = window.CanvasRenderingContext2D.prototype.fillText;
      window.CanvasRenderingContext2D.prototype.fillText = function (...args) {
        if (/^(PLANT|DEFUSE) /.test(args[0]))
          window.__replayActionLabels.push(args[0]);
        return fillText.apply(this, args);
      };
      window.CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (
          args.length === 5 &&
          Math.abs(Math.max(args[3], args[4]) - 22) < 0.01
        )
          window.__replayGrenadeIcons.push(args[0].src);
        if (args[0].src?.includes('_radar_') && args[0].naturalWidth > 0) {
          window.__replayCamera = args.slice(1);
        }
        return drawImage.apply(this, args);
      };
      const calls = [];
      window.__replayCalls = calls;
      const entry = {
        id: 1,
        metadata,
        size: 21000000,
        round_number: 0,
        tick: 0,
        score_t: 2,
        score_ct: 1,
        winner_side: 'T',
      };
      const map = {
        name: metadata.map,
        label: metadata.map,
        grenade_count: 0,
        has_lower_radar: false,
        map_image_path: mapImagePath,
      };
      let entries = [entry],
        capable = localStorage.getItem('replay-test-no-plugin') !== 'true';
      window.__setReplayCapability = (v) => {
        capable = v;
        localStorage.setItem('replay-test-no-plugin', String(!v));
      };
      let job = {
        running: false,
        stage: 'idle',
        completed: 0,
        output: null,
        error: null,
      };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (p) => p,
        async invoke(command, args) {
          calls.push({ command, args });
          if (command.startsWith('plugin:')) return null;
          switch (command) {
            case 'initialize_application':
            case 'report_startup_timing':
              return null;
            case 'get_active_import':
            case 'check_library_update':
              return null;
            case 'list_imports':
            case 'get_favorite_maps':
              return [];
            case 'get_onboarding_state':
              return { completed: true };
            case 'get_favorites_state':
              return {
                collections: [],
                maps: [],
                favorites: {},
                source_matches: {},
              };
            case 'get_replay_capability':
              return capable;
            case 'get_nade_parser_status':
              return job;
            case 'list_replays':
              return entries;
            case 'get_replay':
              return {
                id: 1,
                metadata,
                rounds: rounds.map((r) => r.round),
                map,
                radar,
                round_number: entry.round_number,
                tick: entry.tick,
              };
            case 'get_replay_round':
              return rounds.find((r) => r.round_number === args.number);
            case 'get_replay_round_preview': {
              const r = rounds.find((r) => r.round_number === args.number);
              return {
                ...r,
                frames: [{ ...r.frames[0], tick: r.round.start_tick }],
                grenades: [],
              };
            }
            case 'save_replay_position':
              entry.round_number = args.number;
              entry.tick = args.tick;
              return null;
            case 'delete_replay':
              entries = [];
              return null;
            case 'select_demo_files':
              return ['match.dem'];
            case 'start_replay':
              job = {
                running: true,
                stage: 'replay',
                completed: 2,
                output: null,
                error: null,
              };
              return null;
            case 'stop_nade_parser':
              job = {
                running: false,
                stage: 'failed',
                completed: 2,
                output: null,
                error: 'Parsing cancelled',
              };
              return null;
            default:
              throw new Error('Unexpected IPC ' + command);
          }
        },
      };
    },
    { metadata, rounds, first, mapImagePath, radar },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Force the first round to mount before the shared radar preload resolves.
  await page.route('**/*_radar_psd.png', async (route) => {
    await page.waitForTimeout(200);
    await route.continue();
  });
  await page.goto('http://127.0.0.1:1428/replays/1');
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  const timeline = page.getByRole('slider', { name: 'Таймлайн повтора' });
  const phaseTime = page.locator('.replay-phase-time');
  await page.waitForFunction(() => window.__replayCamera?.length === 4);
  assert.equal(
    await page
      .getByRole('button', { name: 'Предыдущий раунд', exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await phaseTime.textContent(), 'Раунд 0:00');
  const settings = page.getByRole('button', {
    name: 'Настройки реплея',
    exact: true,
  });
  const setOption = async (name, checked) => {
    await settings.click();
    const option = page.getByRole('menuitemcheckbox', { name, exact: true });
    if ((await option.getAttribute('aria-checked')) !== String(checked))
      await option.click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(
      await settings.evaluate((button) => button === document.activeElement),
      true,
    );
  };
  await setOption('Фризтайм', true);
  await seekTimeline(first.frames[0].tick);
  assert.match(await phaseTime.textContent(), /Фризтайм/);
  await page.locator('.replay-phase-segment').first().waitFor();
  await mkdir('dist/replay-checks', { recursive: true });
  await page.screenshot({ path: 'dist/replay-checks/freeze.png' });
  async function seekTimeline(value) {
    await timeline.evaluate((slider, tick) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(slider, String(tick));
      slider.dispatchEvent(new window.Event('input', { bubbles: true }));
    }, value);
  }
  const actionLabelsAt = async (tick) => {
    await seekTimeline(tick);
    return page.evaluate(
      () =>
        new Promise((resolve) => {
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(() =>
              resolve(window.__replayActionLabels),
            ),
          );
        }),
    );
  };
  if (!records) {
    const begin = first.events.find((e) => e.type === 'bomb_plant_begin');
    assert.deepEqual(
      await actionLabelsAt(first.frames[0].tick),
      [],
      'stale flags must not start an action',
    );
    assert.ok(
      (await actionLabelsAt(begin.tick + metadata.tickrate / 2)).includes(
        'PLANT 2.7s',
      ),
    );
    assert.deepEqual(
      await actionLabelsAt(begin.tick + metadata.tickrate * 4),
      [],
      'a stale flag must not extend an expired action',
    );
    assert.deepEqual(
      await actionLabelsAt(begin.tick - 1),
      [],
      'seeking backward must not use a future start',
    );
    await seekTimeline(first.frames[0].tick);
  }
  const checkSliderLayers = async () => {
    const layers = await timeline.evaluate((slider) => {
      const track = document.querySelector('.replay-timeline-track');
      const inputBox = slider.getBoundingClientRect();
      const trackBox = track.getBoundingClientRect();
      return {
        sliderZ: Number(window.getComputedStyle(slider).zIndex),
        trackZ: Number(window.getComputedStyle(track).zIndex) || 0,
        inset: trackBox.left - inputBox.left,
        width: inputBox.width - trackBox.width,
        dy: trackBox.top - inputBox.top,
      };
    });
    assert.ok(layers.sliderZ > layers.trackZ, JSON.stringify(layers));
    assert.equal(layers.inset, 6.5);
    assert.equal(layers.width, 13);
    assert.equal(layers.dy, 0);
  };
  await seekTimeline((first.frames[0].tick + first.round.freeze_end_tick) / 2);
  await checkSliderLayers();
  await page.screenshot({ path: 'dist/replay-checks/freeze-thumb.png' });
  await seekTimeline(first.round.freeze_end_tick - 1);
  assert.equal(await phaseTime.textContent(), 'Фризтайм 0:01');
  await seekTimeline(first.round.freeze_end_tick);
  assert.equal(await phaseTime.textContent(), 'Раунд 0:00');
  const roundClock = page.locator('.replay-round-clock');
  const clockLabel = (seconds) =>
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  assert.equal(
    await roundClock.locator('time').textContent(),
    clockLabel(first.round.duration_seconds),
  );
  await seekTimeline(first.round.freeze_end_tick + 5 * metadata.tickrate);
  assert.equal(await phaseTime.textContent(), 'Раунд 0:05');
  assert.equal(
    await roundClock.locator('time').textContent(),
    clockLabel(first.round.duration_seconds - 5),
  );
  await seekTimeline(first.frames[0].tick);
  assert.match(await phaseTime.textContent(), /Фризтайм/);
  const pixels = await page.locator('canvas').evaluate((c) => {
    const ctx = c.getContext('2d'),
      p = ctx.getImageData(0, 0, c.width, c.height).data;
    let changed = 0;
    for (let i = 0; i < p.length; i += 4)
      if (p[i] + p[i + 1] + p[i + 2] > 120) changed++;
    return { changed, width: c.width, height: c.height };
  });
  assert.ok(pixels.changed > 1000, JSON.stringify(pixels));
  const speeds = page.getByRole('group', {
    name: 'Скорость воспроизведения',
    exact: true,
  });
  await speeds.getByRole('button', { name: '2×', exact: true }).click();
  assert.equal(
    await speeds
      .getByRole('button', { name: '2×', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    await speeds
      .getByRole('button', { name: '1×', exact: true })
      .getAttribute('aria-pressed'),
    'false',
  );
  await speeds.getByRole('button', { name: '1×', exact: true }).click();
  const selectRound = async (number) => {
    await page
      .locator('.replay-round-rail-list button')
      .filter({
        has: page.locator('span', { hasText: new RegExp(`^R${number}$`) }),
      })
      .click();
    await page.waitForFunction(
      (number) =>
        document
          .querySelector('.replay-round-clock small')
          ?.textContent.trim()
          .endsWith(' ' + number),
      number,
    );
    await timeline.waitFor();
  };
  await selectRound(2);
  await selectRound(1);
  await page.getByRole('slider', { name: 'Таймлайн повтора' }).waitFor();
  const radarCanvas = page.locator('canvas');
  const camera = () => page.evaluate(() => window.__replayCamera);
  const initialCamera = await camera();
  const bounds = await radarCanvas.boundingBox();
  const anchor = { x: bounds.width * 0.6, y: bounds.height * 0.4 };
  await page.mouse.move(bounds.x + anchor.x, bounds.y + anchor.y);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(150);
  const zoomed = await camera();
  assert.ok(Math.abs(zoomed[2] / initialCamera[2] - 1.12) < 0.001);
  assert.ok(
    Math.abs((anchor.x - initialCamera[0]) * 1.12 - (anchor.x - zoomed[0])) < 1,
  );
  assert.ok(
    Math.abs((anchor.y - initialCamera[1]) * 1.12 - (anchor.y - zoomed[1])) < 1,
  );
  await radarCanvas.focus();
  const cameraTick = await timeline.inputValue();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  assert.equal(
    await timeline.inputValue(),
    cameraTick,
    'map arrows must pan without seeking',
  );
  for (let i = 0; i < 20; i++) await page.keyboard.press('+');
  await page.waitForTimeout(100);
  assert.ok(Math.abs((await camera())[2] / initialCamera[2] - 6) < 0.001);
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 10,
    bounds.y + bounds.height - 10,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.keyboard.press('Home');
  await page.waitForTimeout(100);
  assert.deepEqual(await camera(), initialCamera);
  await page.keyboard.press('-');
  await page.waitForTimeout(100);
  assert.deepEqual(await camera(), initialCamera, 'zoom cannot go below 1x');
  // Notes pause playback, store text and radar-space shapes, and survive reload.
  const noteTick = Number(await timeline.inputValue());
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .click();
  await page.getByRole('button', { name: 'Заметки', exact: true }).click();
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  await seekTimeline(noteTick);
  const noteText = page.getByRole('textbox', { name: 'Текст заметки' });
  await noteText.fill('Занять плент после флешки');
  await noteText.press('Space');
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  const drawing = page.locator('.replay-annotations');
  const drawShape = async (tool) => {
    await page.getByRole('button', { name: tool, exact: true }).click();
    await page.mouse.move(
      bounds.x + bounds.width - 90,
      bounds.y + bounds.height * 0.55,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width - 30,
      bounds.y + bounds.height * 0.7,
      { steps: 8 },
    );
    await page.mouse.up();
  };
  const paletteToggle = page.getByRole('button', {
    name: 'Палитра цветов',
    exact: true,
  });
  await paletteToggle.click();
  await page.getByRole('button', { name: 'Красный', exact: true }).click();
  await drawShape('Карандаш');
  assert.equal(await drawing.locator('polyline').count(), 1);
  assert.equal(
    await drawing
      .locator('polyline')
      .evaluate((shape) => shape.parentElement.getAttribute('stroke')),
    '#ef4444',
  );
  await paletteToggle.click();
  await page.locator('input[type="color"]').fill('#123abc');
  await page.screenshot({ path: 'dist/replay-checks/drawing-palette.png' });
  await page.locator('input[type="color"]').press('Escape');
  assert.equal(await paletteToggle.getAttribute('aria-expanded'), 'false');
  await drawShape('Стрелка');
  assert.equal(await drawing.locator('path').count(), 1);
  assert.equal(
    await drawing
      .locator('path')
      .evaluate((shape) => shape.parentElement.getAttribute('stroke')),
    '#123abc',
  );
  await drawShape('Круг');
  assert.equal(await drawing.locator('circle').count(), 1);
  await page
    .getByRole('button', { name: 'Отменить рисунок', exact: true })
    .click();
  assert.equal(await drawing.locator('circle').count(), 0);
  const storedPoints = await drawing.locator('polyline').getAttribute('points');
  const originalTransform = await drawing
    .locator(':scope > g')
    .getAttribute('transform');
  await page.getByRole('button', { name: 'Приблизить', exact: true }).click();
  assert.equal(
    await drawing.locator('polyline').getAttribute('points'),
    storedPoints,
  );
  assert.notEqual(
    await drawing.locator(':scope > g').getAttribute('transform'),
    originalTransform,
  );
  await page.getByRole('button', { name: 'Сбросить вид', exact: true }).click();
  await page.screenshot({ path: 'dist/replay-checks/notes.png' });
  await selectRound(2);
  assert.equal(
    await drawing.locator('polyline').count(),
    0,
    'drawings belong to one round',
  );
  assert.equal(await noteText.inputValue(), '');
  await selectRound(1);
  await page.locator('.replay-note-list button').first().click();
  assert.equal(Number(await timeline.inputValue()), noteTick);
  assert.equal(
    await drawing.locator('polyline').getAttribute('points'),
    storedPoints,
  );
  await page
    .getByRole('button', { name: 'Новая заметка', exact: true })
    .click();
  await noteText.fill('Удалить эту заметку');
  await page
    .getByRole('button', { name: 'Удалить заметку', exact: true })
    .click();
  assert.equal(await page.locator('.replay-note-list button').count(), 1);
  const freezeNoteTick = first.round.start_tick + metadata.tickrate;
  await seekTimeline(freezeNoteTick);
  await page
    .getByRole('button', { name: 'Новая заметка', exact: true })
    .click();
  await noteText.fill('План на фризтайм');
  await setOption('Фризтайм', false);
  await page
    .locator('.replay-note-list button')
    .filter({ hasText: 'План на фризтайм' })
    .click();
  assert.equal(
    Number(await timeline.inputValue()),
    freezeNoteTick,
    'opening a freeze-time note restores its exact tick even when freeze time was hidden',
  );
  await page
    .getByRole('button', { name: 'Удалить заметку', exact: true })
    .click();
  await page.reload();
  await timeline.waitFor();
  await page.getByRole('button', { name: /^Заметки/ }).click();
  await page.locator('.replay-note-list button').first().click();
  assert.equal(
    await drawing
      .locator('path')
      .evaluate((shape) => shape.parentElement.getAttribute('stroke')),
    '#123abc',
    'custom colors must survive reloading saved notes',
  );
  assert.equal(
    (await noteText.inputValue()).trim(),
    'Занять плент после флешки',
  );
  assert.equal(
    await drawing.locator('polyline').getAttribute('points'),
    storedPoints,
  );
  await page
    .getByRole('button', { name: 'Закрыть заметки', exact: true })
    .click();
  assert.equal(await drawing.locator('polyline').count(), 0);
  if (!records) {
    for (const [index, file] of [
      'smokegrenade',
      'flashbang',
      'hegrenade',
      'molotov',
    ].entries()) {
      await seekTimeline(
        first.grenades[index].release_tick + metadata.tickrate / 2,
      );
      const svg = await readFile(
        new URL(`../src/assets/grenades_icons/${file}.svg`, import.meta.url),
        'utf8',
      );
      const signature = svg.match(/<path[^>]*\bd="([^"]+)"/)[1].slice(0, 60);
      await page.waitForFunction(
        ({ file, signature }) =>
          window.__replayGrenadeIcons?.some(
            (src) =>
              src.includes(`/${file}.svg`) ||
              decodeURIComponent(src).includes(signature),
          ),
        { file, signature },
      );
    }
    const fireTick = first.round.freeze_end_tick + 67 * metadata.tickrate;
    await seekTimeline(fireTick);
    await page.waitForFunction(() => window.__replayFlameLayers?.length === 33);
    const firstFlames = await page.evaluate(() => window.__replayFlameLayers);
    await page.waitForTimeout(180);
    const nextFlames = await page.evaluate(() => window.__replayFlameLayers);
    assert.notDeepEqual(
      firstFlames,
      nextFlames,
      'NadeGrid flame layers must animate',
    );
    assert.equal(
      Number(await timeline.inputValue()),
      fireTick,
      'fire animation must not advance a paused replay',
    );
    await page.screenshot({ path: 'dist/replay-checks/molotov.png' });
    await seekTimeline(first.round.freeze_end_tick + 74 * metadata.tickrate);
    await page.waitForFunction(() => window.__replayFlameLayers?.length === 0);
  }
  await seekTimeline(noteTick);
  const before = await timeline.inputValue();
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  assert.ok(
    Number(await timeline.inputValue()) > Number(before),
    'timeline must advance',
  );
  await speeds.getByRole('button', { name: '4×', exact: true }).click();
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .click();
  const motion = await timeline.evaluate(async (slider) => {
    const samples = [];
    const started = window.performance.now();
    await new Promise((resolve) => {
      const sample = (now) => {
        samples.push({ now, value: Number(slider.value) });
        if (now - started < 700) window.requestAnimationFrame(sample);
        else resolve();
      };
      window.requestAnimationFrame(sample);
    });
    return samples;
  });
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const advances = motion
    .slice(1)
    .filter((sample, i) => sample.value > motion[i].value).length;
  assert.ok(
    advances / (motion.length - 1) > 0.65,
    `4x scrubber must advance each display frame: ${advances}/${motion.length - 1}`,
  );
  const elapsedSeconds = (motion.at(-1).now - motion[0].now) / 1000;
  const replaySeconds =
    (motion.at(-1).value - motion[0].value) / metadata.tickrate;
  assert.ok(
    Math.abs(replaySeconds / elapsedSeconds - 4) < 0.6,
    `Expected 4x, got ${replaySeconds / elapsedSeconds}`,
  );
  const pausedTick = await timeline.inputValue();
  await page.waitForTimeout(120);
  assert.equal(
    await timeline.inputValue(),
    pausedTick,
    'scrubber must stop on pause',
  );
  await speeds.getByRole('button', { name: '1×', exact: true }).click();
  const grenade = first.grenades[0];
  assert.ok(grenade);
  await page.locator('.replay-throw').first().click();
  await assert.doesNotReject(() =>
    page
      .getByRole('button', { name: 'Копировать координаты', exact: true })
      .waitFor(),
  );
  await page.getByRole('button', { name: 'К броску', exact: true }).click();
  assert.equal(Number(await timeline.inputValue()), grenade.release_tick);
  const throwSeconds = Math.floor(
    (grenade.release_tick - first.round.freeze_end_tick) / metadata.tickrate,
  );
  const expectedThrowTime = `${Math.floor(throwSeconds / 60)}:${String(throwSeconds % 60).padStart(2, '0')}`;
  const roundSeconds = Math.max(0, Math.round(grenade.data.round_time_seconds));
  const expectedRoundTime = `${Math.floor(roundSeconds / 60)}:${String(roundSeconds % 60).padStart(2, '0')}`;
  assert.equal(await phaseTime.textContent(), `Раунд ${expectedThrowTime}`);
  assert.equal(
    await page.locator('.replay-throw').first().locator('time').textContent(),
    expectedRoundTime,
  );
  const grenadeInfo = page.locator('.replay-grenade-detail');
  assert.equal(
    await grenadeInfo.locator('.side-mini').textContent(),
    grenade.data.side,
  );
  assert.equal(
    await grenadeInfo.locator('.detail-thrower-team').textContent(),
    grenade.data.thrower_team,
  );
  assert.equal(
    await page.locator('.replay-throw').first().locator('time').textContent(),
    expectedRoundTime,
  );
  const roundTime = grenadeInfo
    .locator('.replay-detail-metrics > div')
    .filter({ hasText: 'Раунд' })
    .locator('strong');
  assert.equal(await roundTime.textContent(), expectedRoundTime);
  const iconLayout = await page
    .locator('.replay-throw')
    .first()
    .evaluate((row) => {
      const icon = row
        .querySelector('.grenade-map-icon svg')
        .getBoundingClientRect();
      const frame = row
        .querySelector('.replay-nade-icon')
        .getBoundingClientRect();
      return { icon: icon.toJSON(), frame: frame.toJSON() };
    });
  assert.ok(
    iconLayout.icon.width <= iconLayout.frame.width &&
      iconLayout.icon.height <= iconLayout.frame.height,
    JSON.stringify(iconLayout),
  );
  const detailIconLayout = await page
    .locator('.replay-grenade-detail .replay-nade-icon')
    .evaluate((capsule) => {
      const icon = capsule.querySelector('svg').getBoundingClientRect();
      const frame = capsule.getBoundingClientRect();
      return {
        dx: icon.x + icon.width / 2 - frame.x - frame.width / 2,
        dy: icon.y + icon.height / 2 - frame.y - frame.height / 2,
      };
    });
  assert.ok(
    Math.abs(detailIconLayout.dx) <= 1 && Math.abs(detailIconLayout.dy) <= 1,
    `Grenade detail icon must be centered: ${JSON.stringify(detailIconLayout)}`,
  );
  await page.locator('body').click({ position: { x: 5, y: 150 } });
  await page.keyboard.press('ArrowRight');
  assert.ok(Number(await timeline.inputValue()) >= grenade.release_tick);
  assert.equal(
    await roundTime.textContent(),
    expectedRoundTime,
    'grenade round time must remain the time of the throw when seeking',
  );
  await mkdir('dist/replay-checks', { recursive: true });
  await page.screenshot({ path: 'dist/replay-checks/desktop.png' });
  await page.getByRole('button', { name: 'Следующий раунд' }).click();
  await page.getByRole('slider', { name: 'Таймлайн повтора' }).waitFor();
  await page.waitForTimeout(200);
  await page.setViewportSize({ width: 760, height: 560 });
  await page.screenshot({ path: 'dist/replay-checks/compact.png' });
  const layout = await page.evaluate(() => {
    const c = document.querySelector('canvas').getBoundingClientRect();
    const footer = document
      .querySelector('.replay-controls')
      .getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      canvas: c.toJSON(),
      footer: footer.toJSON(),
      height: window.innerHeight,
    };
  });
  assert.equal(layout.overflow, false, JSON.stringify(layout));
  assert.ok(
    layout.canvas.width > 100 && layout.canvas.height > 100,
    JSON.stringify(layout),
  );
  assert.ok(layout.footer.bottom <= layout.height + 1, JSON.stringify(layout));
  await page.locator('.replay-throw').first().click();
  await page
    .getByRole('button', { name: 'Копировать координаты', exact: true })
    .waitFor();
  const detailLayout = await page
    .locator('.replay-grenade-detail')
    .evaluate((panel) => ({
      width: panel.clientWidth,
      scrollWidth: panel.scrollWidth,
    }));
  assert.ok(
    detailLayout.scrollWidth <= detailLayout.width,
    JSON.stringify(detailLayout),
  );
  await page.screenshot({ path: 'dist/replay-checks/compact-detail.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const copyButton = page.getByRole('button', {
    name: 'Копировать координаты',
    exact: true,
  });
  await copyButton.click();
  await page.locator('.detail-copy-button.copied .lucide-check').waitFor();
  assert.equal(
    await page.evaluate(() => window.__copiedReplayCoordinates),
    rounds.find((r) => r.round_number === 2).grenades[0].data.coordinates,
  );
  const confirmation = await copyButton.evaluate((button) => ({
    duration: Number.parseFloat(
      window.getComputedStyle(button).animationDuration,
    ),
    tip: button.dataset.tip,
  }));
  assert.ok(confirmation.duration >= 0.4, JSON.stringify(confirmation));
  assert.equal(confirmation.tip, 'Скопировано');
  await page.waitForTimeout(500);
  await copyButton.click();
  assert.ok(
    await copyButton.evaluate((button) =>
      button.getAnimations().some((animation) => animation.currentTime < 450),
    ),
    'copy confirmation must restart on repeated clicks',
  );
  await page.screenshot({ path: 'dist/replay-checks/copy-confirmation.png' });
  await page.locator('.detail-copy-button:not(.copied) .lucide-copy').waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const bombRound = rounds.find(
    (r) =>
      r.events.some((e) => e.type === 'bomb_planted') &&
      r.events.some((e) => ['bomb_defused', 'bomb_exploded'].includes(e.type)),
  );
  assert.ok(bombRound, 'fixture must contain a resolved bomb round');
  await selectRound(bombRound.round_number);
  await timeline.waitFor();
  const plant = bombRound.events.find((e) => e.type === 'bomb_planted');
  const resolved = bombRound.events.find((e) =>
    ['bomb_defused', 'bomb_exploded'].includes(e.type),
  );
  const terminalLabel =
    resolved.type === 'bomb_defused' ? 'Обезврежена' : 'Взорвалась';
  assert.ok(plant && resolved);
  const plantBegin = bombRound.events.find(
    (e) => e.type === 'bomb_plant_begin' && e.player_id === plant.player_id,
  );
  assert.ok(plantBegin, 'fixture must contain a plant start event');
  assert.deepEqual(
    await actionLabelsAt(bombRound.round.freeze_end_tick),
    [],
    'round-start flags must not show a future plant or defuse',
  );
  assert.deepEqual(await actionLabelsAt(plantBegin.tick - 1), []);
  assert.ok(
    (await actionLabelsAt(plantBegin.tick + metadata.tickrate / 2)).includes(
      'PLANT 2.7s',
    ),
    'real plant countdown must remain visible',
  );
  assert.ok(
    !(await actionLabelsAt(plant.tick)).some((label) =>
      label.startsWith('PLANT '),
    ),
    'plant completion must immediately hide the bar',
  );
  assert.deepEqual(
    await actionLabelsAt(bombRound.round.freeze_end_tick),
    [],
    'rewinding must clear the action indicator',
  );
  const defuseBegin = bombRound.events.find(
    (e) => e.type === 'bomb_defuse_start',
  );
  if (defuseBegin) {
    assert.ok(
      (await actionLabelsAt(defuseBegin.tick + metadata.tickrate)).some(
        (label) => label.startsWith('DEFUSE '),
      ),
    );
    assert.ok(
      !(await actionLabelsAt(resolved.tick)).some((label) =>
        label.startsWith('DEFUSE '),
      ),
      'defuse completion must immediately hide the bar',
    );
  }
  await seekTimeline(plant.tick - 1);
  assert.equal(await page.locator('.replay-clocks.has-bomb').count(), 0);
  await seekTimeline(plant.tick);
  assert.equal(
    await phaseTime.textContent(),
    `Бомба ${clockLabel(plant.data.duration_seconds)}`,
  );
  const bombSegment = await page
    .locator('.replay-phase-segment')
    .nth(2)
    .evaluate((segment) => ({
      left: Number.parseFloat(segment.style.left),
      width: Number.parseFloat(segment.style.width),
    }));
  const bombStart = bombRound.frames[0].tick;
  const bombLength = bombRound.frames.at(-1).tick - bombStart;
  assert.ok(
    Math.abs(bombSegment.left - ((plant.tick - bombStart) / bombLength) * 100) <
      0.01,
  );
  assert.ok(
    Math.abs(
      bombSegment.width - ((resolved.tick - plant.tick) / bombLength) * 100,
    ) < 0.01,
  );
  const bombClock = page.locator('.replay-clocks.has-bomb');
  assert.equal(
    await bombClock.locator('time').textContent(),
    clockLabel(plant.data.duration_seconds),
  );
  await seekTimeline(plant.tick + 5 * metadata.tickrate);
  await checkSliderLayers();
  assert.equal(
    await phaseTime.textContent(),
    `Бомба ${clockLabel(plant.data.duration_seconds - 5)}`,
  );
  assert.equal(
    await bombClock.locator('time').textContent(),
    clockLabel(plant.data.duration_seconds - 5),
  );
  assert.equal(
    await roundClock.locator('time').textContent(),
    clockLabel(plant.data.duration_seconds - 5),
  );
  await page.screenshot({ path: 'dist/replay-checks/bomb-compact.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: 'dist/replay-checks/bomb-desktop.png' });
  await seekTimeline(resolved.tick);
  assert.equal(await phaseTime.textContent(), terminalLabel);
  assert.ok((await bombClock.textContent()).includes(terminalLabel));
  await seekTimeline(plant.tick + metadata.tickrate);
  assert.equal(
    await phaseTime.textContent(),
    `Бомба ${clockLabel(plant.data.duration_seconds - 1)}`,
  );
  assert.equal(
    await bombClock.locator('time').textContent(),
    clockLabel(plant.data.duration_seconds - 1),
  );
  const postPlantGrenade = bombRound.grenades.find(
    (grenade) => grenade.release_tick >= plant.tick,
  );
  if (postPlantGrenade) {
    const postPlantSeconds = Math.max(
      0,
      Math.ceil(
        plant.data.duration_seconds -
          (postPlantGrenade.release_tick - plant.tick) / metadata.tickrate,
      ),
    );
    const postPlantIndex = bombRound.grenades.indexOf(postPlantGrenade);
    const postPlantTime = await page
      .locator('.replay-throw')
      .nth(postPlantIndex)
      .locator('time')
      .textContent();
    assert.equal(postPlantTime, clockLabel(postPlantSeconds));
    await page.locator('.replay-throw').nth(postPlantIndex).click();
    const bombMetric = page
      .locator('.replay-detail-metrics > div')
      .filter({ hasText: 'Бомба' })
      .locator('strong');
    assert.equal(await bombMetric.textContent(), postPlantTime);
    await seekTimeline(plant.tick + 2 * metadata.tickrate);
    assert.equal(
      await bombMetric.textContent(),
      postPlantTime,
      'throw timestamp must stay fixed when seeking',
    );
  }
  await page.locator('.replay-round-rail-list button[aria-current]').hover();
  assert.equal(
    await page.locator('.replay-round-rail-card-reason').textContent(),
    'Бомба ' + terminalLabel.toLowerCase(),
  );
  assert.match(
    await page.locator('.replay-round-rail-card-feed').textContent(),
    /Бомба установлена/,
  );
  assert.doesNotMatch(
    await page.locator('.replay-round-rail-card-feed').textContent(),
    /bomb_planted/,
  );
  await settings.click();
  await page.locator('.replay-heading h1').click();
  assert.equal(
    await page.getByRole('menu').count(),
    0,
    'outside click must close settings',
  );

  await selectRound(1);
  const actionStart = first.round.freeze_end_tick;
  const roundEnd = first.frames.at(-1).tick;
  await seekTimeline(actionStart + 30 * metadata.tickrate);
  await setOption('Фризтайм', false);
  assert.equal(
    Number(await timeline.inputValue()),
    actionStart + 30 * metadata.tickrate,
  );
  await setOption('Фризтайм', true);
  await seekTimeline(actionStart - 1);
  await setOption('Фризтайм', false);
  assert.equal(
    Number(await timeline.inputValue()),
    actionStart,
    'hiding freeze only skips a position within freeze',
  );
  await page.locator('.replay-heading h1').click();
  await page.keyboard.press('ArrowLeft');
  assert.equal(
    Number(await timeline.inputValue()),
    actionStart,
    'keyboard seek must respect hidden freeze',
  );

  const allMarkers = await page
    .locator('.replay-timeline-grenade-marker')
    .count();
  await page.getByRole('button', { name: 'Увеличить', exact: true }).click();
  await page.getByRole('button', { name: 'Увеличить', exact: true }).click();
  assert.equal(
    await phaseTime.textContent(),
    'Раунд 0:00',
    'zoom must not change the current-time label',
  );
  assert.equal(await timeline.getAttribute('aria-valuetext'), 'Раунд 0:00');
  const visibleMarkers = await page
    .locator('.replay-timeline-grenade-marker')
    .count();
  assert.ok(visibleMarkers < allMarkers, 'offscreen grenades must be hidden');
  const markerWindow = await timeline.evaluate((slider) => ({
    min: Number(slider.min),
    max: Number(slider.max),
    ticks: [
      ...document.querySelectorAll(
        '.replay-timeline-grenade-marker, .replay-event-ticks [data-tick]',
      ),
    ].map((m) => Number(m.dataset.tick)),
  }));
  assert.ok(
    markerWindow.ticks.every(
      (tick) => tick >= markerWindow.min && tick <= markerWindow.max,
    ),
    JSON.stringify(markerWindow),
  );
  await page
    .getByRole('button', { name: 'Сбросить масштаб', exact: true })
    .click();
  assert.equal(
    Number(await timeline.inputValue()),
    actionStart,
    'zoom must not seek the replay',
  );

  await seekTimeline(roundEnd);
  await page.locator('.replay-heading h1').click();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  assert.ok(
    Number(await timeline.inputValue()) < roundEnd,
    'space must restart a finished round',
  );
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();

  await setOption('Автоследующий раунд', true);
  const finishRound = async () => {
    await seekTimeline(roundEnd - 1);
    await page
      .getByRole('button', { name: 'Воспроизвести', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Воспроизвести', exact: true })
      .waitFor();
  };
  await finishRound();
  await seekTimeline(actionStart + 10 * metadata.tickrate);
  await page.waitForTimeout(750);
  assert.equal(
    await page
      .locator('.replay-round-rail-list button[aria-current] span')
      .textContent(),
    'R1',
    'manual seek must cancel pending auto-next',
  );
  assert.equal(
    Number(await timeline.inputValue()),
    actionStart + 10 * metadata.tickrate,
  );
  await finishRound();
  await setOption('Автоследующий раунд', false);
  await page.waitForTimeout(750);
  assert.equal(
    await page
      .locator('.replay-round-rail-list button[aria-current] span')
      .textContent(),
    'R1',
    'disabling auto-next must cancel an already scheduled transition',
  );
  await setOption('Автоследующий раунд', true);
  await finishRound();
  await page.evaluate(() => window.dispatchEvent(new window.Event('blur')));
  await page.waitForTimeout(750);
  assert.equal(
    await page
      .locator('.replay-round-rail-list button[aria-current] span')
      .textContent(),
    'R1',
    'inactive windows must not auto-advance',
  );
  await page.evaluate(() => window.dispatchEvent(new window.Event('focus')));
  await finishRound();
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.replay-round-rail-list button[aria-current] span',
      )?.textContent === 'R2',
  );
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await selectRound(1);
  await finishRound();
  await page.getByRole('button', { name: 'История матчей' }).click();
  await page.waitForTimeout(750);
  assert.equal(
    new URL(page.url()).pathname,
    '/replays',
    'auto-next must not survive leaving the player',
  );
  await page
    .getByRole('link')
    .filter({ has: page.locator('.replay-map-code') })
    .waitFor();
  await page.screenshot({ path: 'dist/replay-checks/history.png' });
  await page.evaluate(() => window.__setReplayCapability(false));
  await page.reload();
  await page
    .getByRole('link', { name: 'Обновить Nade Parser', exact: true })
    .waitFor();
  await page
    .getByRole('link')
    .filter({ has: page.locator('.replay-map-code') })
    .click();
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'История матчей' }).click();
  await page.evaluate(() => window.__setReplayCapability(true));
  await page.reload();
  await page
    .getByRole('link')
    .filter({ has: page.locator('.replay-map-code') })
    .waitFor();
  await page.getByRole('button', { name: 'Открыть демо', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить разбор' }).waitFor();
  await page.getByRole('button', { name: 'Отменить разбор' }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Parsing cancelled' })
    .waitFor();
  await page.getByRole('button', { name: 'Удалить матч', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('heading', { name: 'Нет сохранённых матчей' }).waitFor();
  const failedRadarPage = await context.newPage();
  failedRadarPage.on('pageerror', (e) => errors.push(e.message));
  await failedRadarPage.route('**/*_radar_psd.png', (route) => route.abort());
  await failedRadarPage.goto('http://127.0.0.1:1428/replays/1');
  await failedRadarPage
    .getByText('Радар этой карты недоступен', { exact: true })
    .waitFor();
  await failedRadarPage.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      canvas: pixels,
      layout,
      rounds: rounds.length,
      grenades: rounds.reduce((count, r) => count + r.grenades.length, 0),
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
