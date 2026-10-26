// Browser regression with real parser output and mocked native IPC.
// node tests/replay-ui.mjs <playwright package directory> <replay NDJSON>
/* global window, document, localStorage, console */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { createServer } from 'vite';

const { chromium } = await import(
  pathToFileURL(process.argv[2] + '/index.mjs').href
);
const records = (await readFile(process.argv[3], 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse);
const metadata = records.find((r) => r.type === 'complete');
const rounds = records
  .filter(
    (r) => r.type === 'round' && r.round_number >= 1 && r.round_number <= 3,
  )
  .map((r) => ({
    ...r,
    grenades: [],
    frames: r.frames.map((f) => ({
      ...f,
      players: f.players.map(({ weapons, buttons, ...player }) => {
        void weapons;
        void buttons;
        return player;
      }),
    })),
  }));
for (const record of records.filter((r) => r.type === 'grenade')) {
  const round = rounds.find((r) => r.round_number === record.round_number);
  if (!round) continue;
  round.grenades.push(record.grenade);
  round.events.push(...record.events);
}
for (const round of rounds) round.events.sort((a, b) => a.tick - b.tick);
const first = rounds.find((r) => r.round_number === 1) ?? rounds[0];
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
    ({ metadata, rounds, first }) => {
      localStorage.setItem('nadeviewer.locale', 'ru');
      Object.defineProperty(window.navigator, 'clipboard', {
        value: {
          async writeText(text) {
            window.__copiedReplayCoordinates = text;
          },
        },
      });
      const drawImage = window.CanvasRenderingContext2D.prototype.drawImage;
      window.CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        window.__replayCamera = args.slice(1);
        return drawImage.apply(this, args);
      };
      const calls = [];
      window.__replayCalls = calls;
      const entry = {
        id: 1,
        metadata,
        size: 21000000,
        round_number: first.round_number,
        tick: first.frames[0].tick,
      };
      const map = {
        name: 'Mirage',
        label: 'Mirage',
        grenade_count: 0,
        has_lower_radar: false,
        map_image_path:
          '/@fs/F:/Dev/NadeViewer/src-tauri/resources/maps/2d/de_mirage_radar_psd.png',
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
                radar: { pos_x: -3230, pos_y: 1713, scale: 5, split_z: null },
                round_number: entry.round_number,
                tick: entry.tick,
              };
            case 'get_replay_round':
              return rounds.find((r) => r.round_number === args.number);
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
    { metadata, rounds, first },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:1428/replays/1');
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  const timeline = page.getByRole('slider', { name: 'Таймлайн повтора' });
  const phaseTime = page.locator('.replay-phase-time');
  assert.match(await phaseTime.textContent(), /Фризтайм/);
  await page.locator('.replay-freeze-segment').waitFor();
  await mkdir('dist/replay-checks', { recursive: true });
  await page.screenshot({ path: 'dist/replay-checks/freeze.png' });
  const seekTimeline = async (value) => {
    await timeline.evaluate((slider, tick) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(slider, String(tick));
      slider.dispatchEvent(new window.Event('input', { bubbles: true }));
    }, value);
  };
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
  const roundSelect = page.getByRole('combobox', {
    name: 'Раунд',
    exact: true,
  });
  await roundSelect.selectOption('2');
  assert.equal(await roundSelect.inputValue(), '2');
  await roundSelect.selectOption('1');
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
    page.getByRole('button', { name: 'Копировать координаты' }).waitFor(),
  );
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
  await page.getByRole('button', { name: 'Копировать координаты' }).waitFor();
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
  await roundSelect.selectOption('3');
  await timeline.waitFor();
  const bombRound = rounds.find((r) => r.round_number === 3);
  const plant = bombRound.events.find((e) => e.type === 'bomb_planted');
  const defused = bombRound.events.find((e) => e.type === 'bomb_defused');
  assert.ok(plant && defused);
  await seekTimeline(plant.tick - 1);
  assert.equal(await page.locator('.replay-clocks.has-bomb').count(), 0);
  await seekTimeline(plant.tick);
  assert.equal(
    await phaseTime.textContent(),
    `Бомба ${clockLabel(plant.data.duration_seconds)}`,
  );
  const bombSegment = await page
    .locator('.replay-bomb-segment')
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
      bombSegment.width - ((defused.tick - plant.tick) / bombLength) * 100,
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
  await seekTimeline(defused.tick);
  assert.equal(await phaseTime.textContent(), 'Обезврежена');
  assert.match(await bombClock.textContent(), /Обезврежена/);
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
  }
  await page.getByRole('button', { name: 'История матчей' }).click();
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
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      canvas: pixels,
      layout,
      rounds: rounds.length,
      grenades: records.filter((r) => r.type === 'grenade').length,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
