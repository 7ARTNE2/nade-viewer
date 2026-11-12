// Browser regression with deterministic fixtures and mocked native IPC.
// Optional real parser output: node tests/replay-ui.mjs <playwright directory> <NDJSON>
/* global window, document, localStorage, console */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
  // The IPC fixture lives outside the browser so reloads exercise backend reads.
  let storedNotes = [];
  await context.exposeBinding(
    '__replayNotesBackend',
    async (_, command, args) => {
      if (command === 'list_replay_notes') return storedNotes;
      if (command === 'delete_replay') {
        storedNotes = storedNotes.filter((item) => item.replay_id !== args.id);
        return null;
      }
      if (command === 'delete_replays' || command === 'clear_replays') {
        storedNotes = storedNotes.filter(
          (item) =>
            command !== 'clear_replays' && !args.ids.includes(item.replay_id),
        );
        return null;
      }
      const previous = storedNotes.filter(
        (item) => item.replay_id === args.replayId,
      );
      const saved = args.notes.map((note) => {
        const old = previous.find((item) => item.note.id === note.id);
        return {
          replay_id: args.replayId,
          note,
          round_summary: rounds.find((r) => r.round_number === note.round)
            ?.round,
          updated_at:
            old && JSON.stringify(old.note) === JSON.stringify(note)
              ? old.updated_at
              : Date.now(),
        };
      });
      storedNotes = [
        ...storedNotes.filter((item) => item.replay_id !== args.replayId),
        ...saved,
      ];
      return saved;
    },
  );
  await context.addInitScript(
    ({ metadata, rounds, mapImagePath, radar }) => {
      localStorage.setItem('nadeviewer.locale', 'ru');
      const testMap = localStorage.getItem('replay-test-map');
      if (testMap === 'nuke' || testMap === 'vertigo') {
        metadata.map = `de_${testMap}`;
        mapImagePath = mapImagePath.replace(
          /de_[a-z0-9]+_radar/,
          `de_${testMap}_radar`,
        );
        radar =
          testMap === 'nuke'
            ? { pos_x: -3453, pos_y: 2887, scale: 7, split_z: -495 }
            : { ...radar, split_z: 11700 };
        for (const round of rounds) {
          for (const frame of round.frames) {
            frame.players = frame.players.map((player, index) => ({
              ...player,
              z: index < 5 ? 0 : -700,
            }));
          }
        }
        if (testMap === 'nuke') {
          const round = rounds.find((item) => item.round_number === 1);
          const kill = round.events.find((event) => event.type === 'kill');
          round.events.push(
            ...Array.from({ length: 7 }, (_, index) => ({
              ...kill,
              tick:
                round.round.freeze_end_tick +
                metadata.tickrate * (30 + index / 8),
              target_id: String(index + 2),
              data: { weapon: 'ak47', headshot: index === 6 },
            })),
          );
          round.events.sort((a, b) => a.tick - b.tick);
        }
      }
      Object.defineProperty(window.navigator, 'clipboard', {
        value: {
          async write(items) {
            if (window.__failScreenshotCopy)
              throw new Error('Clipboard denied');
            const blob = await items[0].getType('image/png');
            window.__copiedReplayScreenshot = Array.from(
              new Uint8Array(await blob.arrayBuffer()),
            );
          },
          async writeText(text) {
            window.__copiedReplayCoordinates = text;
          },
        },
      });
      const drawImage = window.CanvasRenderingContext2D.prototype.drawImage;
      const clearRect = window.CanvasRenderingContext2D.prototype.clearRect;
      window.CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        window.__replayDrawCount = (window.__replayDrawCount ?? 0) + 1;
        window.__replayActionLabels = [];
        window.__replayGrenadeIcons = [];
        window.__replayFlameLayers = [];
        this.canvas.dataset.playerNames = '[]';
        return clearRect.apply(this, args);
      };
      const fill = window.CanvasRenderingContext2D.prototype.fill;
      window.CanvasRenderingContext2D.prototype.fill = function (...args) {
        if (
          args[0] instanceof window.Path2D &&
          this.canvas.matches('.replay-map canvas')
        ) {
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
        if (/^Player \d+$/.test(args[0])) {
          const names = JSON.parse(this.canvas.dataset.playerNames || '[]');
          names.push(args[0]);
          this.canvas.dataset.playerNames = JSON.stringify(names);
        }
        return fillText.apply(this, args);
      };
      window.CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (
          args[0] instanceof window.HTMLCanvasElement &&
          this.canvas.matches('.replay-map canvas') &&
          [
            'rgba(249, 115, 22, 0.76)',
            'rgba(251, 191, 36, 0.88)',
            'rgba(255, 247, 237, 0.92)',
          ].includes(this.fillStyle)
        ) {
          const transform = this.getTransform();
          window.__replayFlameLayers.push({
            color: this.fillStyle,
            alpha: this.globalAlpha,
            a: transform.a,
            d: transform.d,
          });
        }
        if (
          args.length === 5 &&
          Math.abs(Math.max(args[3], args[4]) - 19) < 0.01
        )
          window.__replayGrenadeIcons.push(args[0].src);
        if (args[0].src?.includes('_radar_') && args[0].naturalWidth > 0) {
          window.__replayCamera = args.slice(1);
          this.canvas.dataset.camera = JSON.stringify(args.slice(1));
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
        has_lower_radar: testMap === 'nuke' || testMap === 'vertigo',
        map_image_path: mapImagePath,
        lower_map_image_path: testMap
          ? mapImagePath.replace('_radar_', '_lower_radar_')
          : null,
      };
      let entries = [entry],
        capable = localStorage.getItem('replay-test-no-plugin') !== 'true';
      window.__setSecondReplay = (enabled) => {
        localStorage.setItem('replay-test-second-match', String(enabled));
        entries = enabled
          ? [
              entry,
              {
                ...entry,
                id: 2,
                metadata: {
                  ...metadata,
                  map: 'Inferno',
                  demo_filename: 'second-replay.dem',
                },
              },
            ]
          : [entry];
      };
      window.__setSecondReplay(
        localStorage.getItem('replay-test-second-match') === 'true',
      );
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
            case 'list_replay_notes':
              if (window.__failReplayNotesLoad)
                throw new Error('Test notes read failed');
              return window.__replayNotesBackend(command, args);
            case 'save_replay_notes':
              if (window.__failReplayNotesSave)
                throw new Error('Test notes save failed');
              if (window.__replayNotesSaveDelay)
                await new Promise((resolve) =>
                  window.setTimeout(resolve, window.__replayNotesSaveDelay),
                );
              return window.__replayNotesBackend(command, args);
            case 'get_replay':
              return {
                id: args.id,
                metadata,
                rounds: rounds.map((r) => r.round),
                map,
                radar,
                round_number: entry.round_number,
                tick: entry.tick,
              };
            case 'get_parser_profiles':
              return [
                {
                  id: 'v5',
                  label: 'demoinfocs v5.2.0',
                  installed: true,
                  capabilities: ['replay_v1'],
                },
                {
                  id: 'v6',
                  label: 'demoinfocs v6.0.0-rc.1',
                  installed: true,
                  capabilities: ['replay_v1'],
                },
              ];
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
            case 'save_replay_screenshot':
              if (window.__failScreenshotSave) throw new Error('Save failed');
              return window.__cancelScreenshotSave ? null : 'replay-map.png';
            case 'delete_replay':
              entries = [];
              await window.__replayNotesBackend(command, args);
              return null;
            case 'delete_replays':
              entries = entries.filter((item) => !args.ids.includes(item.id));
              await window.__replayNotesBackend(command, args);
              return null;
            case 'clear_replays':
              entries = [];
              await window.__replayNotesBackend(command, args);
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
  await page.route('**/__animation-check', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
  );
  await page.goto('http://127.0.0.1:1428/__animation-check');
  const animationChecks = await page.evaluate(async () => {
    const originalRequest = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    const pending = new Map();
    let id = 0;
    window.requestAnimationFrame = (callback) => {
      pending.set(++id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => pending.delete(id);
    const { onReplayAnimationFrame } =
      await import('/src/lib/replayAnimation.ts');
    const step = (now) => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(now);
    };
    try {
      return [60, 120, 144, 165, 240].map((refreshRate) => {
        const frames = [];
        let clock = -1;
        // Subscribe views first to verify ordering independently of mount order.
        const stopView = onReplayAnimationFrame((now) =>
          frames.push({ now, clock }),
        );
        const stopSecondView = onReplayAnimationFrame(() => undefined);
        const stopClock = onReplayAnimationFrame((now) => {
          clock = now;
        }, 'clock');
        let singleLoop = true;
        for (let i = 0; i <= refreshRate * 10; i++) {
          singleLoop &&= pending.size === 1;
          step((i * 1000) / refreshRate);
        }
        const count = frames.length;
        const gaps = frames
          .slice(1)
          .map((frame, index) => frame.now - frames[index].now);
        step(10500);
        const afterStall = frames.length - count;
        stopClock();
        stopView();
        stopSecondView();
        return {
          refreshRate,
          count,
          singleLoop,
          freshClock: frames.every((frame) => frame.now === frame.clock),
          maxGap: Math.max(...gaps),
          afterStall,
          stopped: pending.size === 0,
        };
      });
    } finally {
      window.requestAnimationFrame = originalRequest;
      window.cancelAnimationFrame = originalCancel;
    }
  });
  for (const check of animationChecks) {
    assert.equal(check.count, 601, `${check.refreshRate} Hz: 60 FPS over 10s`);
    assert.ok(
      check.singleLoop,
      'both radars and clock share one animation loop',
    );
    assert.ok(check.freshClock, 'views must draw the current frame clock');
    assert.ok(check.maxGap <= 1000 / 60 + 1000 / check.refreshRate + 0.5);
    assert.equal(
      check.afterStall,
      1,
      'never render a burst of catch-up frames',
    );
    assert.ok(check.stopped, 'unsubscribe must cancel the shared loop');
  }
  const smokeChecks = await page.evaluate(async () => {
    const { activeSmokes, buildSmokeTimeline } =
      await import('/src/lib/replayPlayback.ts');
    return [64, 128].map((tickrate) => {
      const event = (seconds, type, id = 1) => ({
        tick: seconds * tickrate,
        type,
        x: 100,
        y: 200,
        z: 0,
        data: { grenade_entity_id: id },
      });
      const round = {
        round: { start_tick: 0, end_tick: 60 * tickrate },
        frames: [],
        events: [event(1, 'smoke_start'), event(22, 'smoke_expired')],
      };
      const timeline = buildSmokeTimeline(round);
      const at = (seconds) =>
        activeSmokes(round, seconds * tickrate, tickrate, timeline);
      const before = at(0);
      const late = at(20);
      const expired = at(22);
      const after = at(23);
      const rewind = at(10);
      const missing = { ...round, events: [event(1, 'smoke_start')] };
      const long = {
        ...round,
        events: [event(1, 'smoke_start'), event(40, 'smoke_expired')],
      };
      const reused = {
        ...round,
        events: [
          ...round.events,
          event(25, 'smoke_start'),
          event(30, 'smoke_expired'),
        ],
      };
      return {
        before,
        late,
        expired,
        after,
        rewind,
        long: activeSmokes(long, 30 * tickrate, tickrate),
        missing: activeSmokes(missing, 30 * tickrate, tickrate),
        roundEnd: activeSmokes(missing, 60 * tickrate, tickrate),
        reused: activeSmokes(reused, 26 * tickrate, tickrate),
        reuseGap: activeSmokes(reused, 24 * tickrate, tickrate),
      };
    });
  });
  for (const check of smokeChecks) {
    assert.deepEqual(check.before, []);
    assert.equal(check.late.length, 1, 'smoke remains visible past 18s');
    assert.equal(check.late[0].remainingSeconds, 2);
    assert.equal(check.late[0].progress, 19 / 21);
    assert.deepEqual(check.expired, [], 'remove at the expiration tick');
    assert.deepEqual(check.after, []);
    assert.equal(check.rewind[0].remainingSeconds, 12);
    assert.equal(check.long[0].remainingSeconds, 10, 'no replacement time cap');
    assert.equal(check.missing[0].remainingSeconds, 30);
    assert.deepEqual(check.roundEnd, [], 'missing expiration uses round end');
    assert.equal(check.reused[0].remainingSeconds, 4);
    assert.deepEqual(check.reuseGap, []);
  }
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
  if (!records) {
    const assistState = (container) =>
      container.locator('.replay-kill-assist').evaluateAll((nodes) =>
        nodes.map((node) => ({
          text: node.textContent.trim(),
          type: node.classList.contains('flash') ? 'flash' : 'damage',
          color: window.getComputedStyle(node).color,
          icons: node.querySelectorAll('img').length,
        })),
      );
    const expected = [
      [],
      [
        {
          text: '+Player 2',
          type: 'damage',
          color: 'rgb(255, 152, 107)',
          icons: 0,
        },
      ],
      [
        {
          text: '+Player 2',
          type: 'damage',
          color: 'rgb(255, 152, 107)',
          icons: 0,
        },
        {
          text: '+Player 4',
          type: 'damage',
          color: 'rgb(255, 152, 107)',
          icons: 0,
        },
        {
          text: '+Player 3',
          type: 'flash',
          color: 'rgb(251, 191, 36)',
          icons: 1,
        },
      ],
      [
        {
          text: '+Player 2',
          type: 'flash',
          color: 'rgb(251, 191, 36)',
          icons: 1,
        },
      ],
      [{ text: '', type: 'flash', color: 'rgb(251, 191, 36)', icons: 1 }],
    ];
    const kills = first.events.filter((event) => event.type === 'kill');
    for (const [index, event] of kills.entries()) {
      await seekTimeline(event.tick);
      const feed = page.locator('.replay-killfeed-row').last();
      assert.deepEqual(
        await assistState(feed),
        expected[index],
        `killfeed assist case ${index}`,
      );
      await page.locator('.replay-round-rail-list button.active').hover();
      const roundPreview = page
        .locator('.replay-round-rail-card-kill')
        .nth(index);
      await roundPreview.waitFor();
      assert.deepEqual(
        await assistState(roundPreview),
        expected[index],
        `round preview must match killfeed case ${index}`,
      );
      if (index === 2)
        await page.screenshot({ path: 'dist/replay-checks/round-assists.png' });
      await page
        .locator(
          `.replay-timeline-event-marker[data-tick="${event.tick}"] button`,
        )
        .hover();
      const timelinePreview = page.locator('.replay-timeline-kill-preview');
      await timelinePreview.waitFor();
      assert.deepEqual(
        await assistState(timelinePreview),
        expected[index],
        `timeline preview must match killfeed case ${index}`,
      );
      if (index === 2)
        await page.screenshot({
          path: 'dist/replay-checks/timeline-assists.png',
        });
    }
    // A hovered, unloaded round uses its own event history for damage assists.
    await page
      .locator('.replay-round-rail-list button')
      .filter({ has: page.locator('span', { hasText: /^R2$/ }) })
      .hover();
    await page.locator('.replay-round-rail-card-kill').nth(2).waitFor();
    assert.deepEqual(
      await assistState(page.locator('.replay-round-rail-card-kill').nth(2)),
      expected[2],
    );
    await page.mouse.move(0, 0);
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
  const firstKill = first.events.find((event) => event.type === 'kill');
  if (firstKill) {
    const feedRow = page.locator(
      `.replay-killfeed-row[data-tick="${firstKill.tick}"]`,
    );
    await seekTimeline(firstKill.tick - 1);
    assert.equal(await feedRow.count(), 0, 'future kills must be hidden');
    await seekTimeline(firstKill.tick);
    assert.equal(await feedRow.count(), 1);
    assert.equal(Number(await feedRow.evaluate((row) => row.style.opacity)), 1);
    await seekTimeline(firstKill.tick + metadata.tickrate * 5.85);
    const pausedOpacity = Number(
      await feedRow.evaluate((row) => row.style.opacity),
    );
    assert.ok(
      Math.abs(pausedOpacity - 0.5) < 0.001,
      `fade opacity: ${pausedOpacity}`,
    );
    await page.waitForTimeout(350);
    assert.equal(
      Number(await feedRow.evaluate((row) => row.style.opacity)),
      pausedOpacity,
      'killfeed fade must stop on pause',
    );
    await seekTimeline(firstKill.tick + metadata.tickrate * 6);
    assert.equal(await feedRow.count(), 0, 'kills expire at six demo seconds');
    await seekTimeline(firstKill.tick);
    assert.equal(
      Number(await feedRow.evaluate((row) => row.style.opacity)),
      1,
      'seeking backwards restores the killfeed',
    );
    await speeds.getByRole('button', { name: '2×', exact: true }).click();
    await seekTimeline(firstKill.tick + metadata.tickrate * 5);
    const started = Date.now();
    await page
      .getByRole('button', { name: 'Воспроизвести', exact: true })
      .click();
    await feedRow.waitFor({ state: 'detached', timeout: 2000 });
    assert.ok(
      Date.now() - started < 1500,
      'killfeed lifetime must follow playback speed',
    );
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await speeds.getByRole('button', { name: '1×', exact: true }).click();
    await seekTimeline(first.frames[0].tick);
  }
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
  const seekStep = 5 * metadata.tickrate;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  assert.equal(
    Number(await timeline.inputValue()),
    Number(cameraTick) + seekStep,
    'map arrows must seek by five demo seconds',
  );
  assert.deepEqual(await camera(), zoomed, 'arrows must not pan the map');
  await page.keyboard.press('ArrowLeft');
  assert.equal(Number(await timeline.inputValue()), Number(cameraTick));
  await seekTimeline(Number(cameraTick) + seekStep + 0.5);
  await radarCanvas.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    Number(await timeline.inputValue()),
    Number(cameraTick) + 2 * seekStep + 0.5,
  );
  await seekTimeline(Number(cameraTick) + seekStep + 0.5);
  await radarCanvas.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(Number(await timeline.inputValue()), Number(cameraTick) + 0.5);
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await speeds
      .getByRole('button', { name: '2×', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await speeds
      .getByRole('button', { name: '4×', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  assert.equal(
    await speeds
      .getByRole('button', { name: '0.25×', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await speeds
      .getByRole('button', { name: '1×', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  const playbackUpdates = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let previousDraws;
        let samples = 0;
        let skipped = 0;
        let timerWrites = 0;
        const observer = new window.MutationObserver((records) => {
          timerWrites += records.length;
        });
        observer.observe(document.querySelector('.replay-phase-time'), {
          childList: true,
          characterData: true,
          subtree: true,
        });
        const sample = () => {
          const draws = window.__replayDrawCount;
          if (previousDraws !== undefined) {
            if (draws === previousDraws) skipped += 1;
            samples += 1;
          }
          previousDraws = draws;
          if (samples === 30) {
            observer.disconnect();
            resolve({ skipped, timerWrites });
          } else window.requestAnimationFrame(sample);
        };
        window.requestAnimationFrame(sample);
      }),
  );
  assert.ok(
    playbackUpdates.skipped <= 1,
    `radar must follow display frames during playback; skipped ${playbackUpdates.skipped}/30`,
  );
  assert.ok(
    playbackUpdates.timerWrites <= 3,
    `timeline must not rewrite identical timer text every frame: ${playbackUpdates.timerWrites} writes`,
  );
  await page.keyboard.press('ArrowUp');
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  await page.keyboard.press('ArrowLeft');
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  const steppedTick = Number(await timeline.inputValue());
  await page.waitForTimeout(100);
  assert.equal(
    Number(await timeline.inputValue()),
    steppedTick,
    'keyboard seeking pauses playback',
  );
  await page.keyboard.press('ArrowDown');
  await seekTimeline(Number(cameraTick));
  await radarCanvas.focus();
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
  await page.waitForFunction(() =>
    window.__replayCalls.some((call) => call.command === 'save_replay_notes'),
  );
  assert.equal(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        key.startsWith('nadeviewer.replay-notes.'),
      ),
    ),
    false,
    'notes must use SQLite IPC instead of localStorage',
  );
  await page.evaluate(() => {
    window.__failReplayNotesSave = true;
  });
  await noteText.fill('Проверка ошибки сохранения');
  const noteSaveError = page
    .getByRole('alert')
    .filter({ hasText: 'Не удалось загрузить или сохранить заметки.' });
  await noteSaveError.waitFor();
  assert.equal(
    await noteText.inputValue(),
    'Проверка ошибки сохранения',
    'a failed write must retain the draft',
  );
  await page.evaluate(() => {
    window.__failReplayNotesSave = false;
  });
  await noteSaveError
    .getByRole('button', { name: 'Повторить', exact: true })
    .click();
  await noteSaveError.waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.__replayNotesSaveDelay = 100;
  });
  await noteText.fill('Промежуточный текст');
  await noteText.fill('Занять плент после флешки');
  await page.waitForFunction(
    () => !document.querySelector('.replay-notes-panel [role="status"]'),
  );
  assert.equal(
    storedNotes.find((item) => item.replay_id === 1).note.text,
    'Занять плент после флешки',
    'queued saves must persist the newest edit',
  );
  await page.evaluate(() => {
    window.__replayNotesSaveDelay = 0;
  });
  assert.equal(
    await page
      .locator('.replay-round-rail-list button.active .replay-round-note-badge')
      .count(),
    1,
    'round badges update immediately when notes are added',
  );
  await noteText.press('Space');
  const textTick = await timeline.inputValue();
  await noteText.press('ArrowUp');
  await noteText.press('ArrowLeft');
  assert.equal(
    await timeline.inputValue(),
    textTick,
    'text arrows must not seek',
  );
  assert.equal(
    await speeds
      .getByRole('button', { name: '1×', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page
    .getByRole('button', { name: 'Воспроизвести', exact: true })
    .waitFor();
  const drawing = page.locator('.replay-annotations');
  const longNote =
    'Проверить выход на плент после флешки и дождаться поддержки команды.\n' +
    'ДлиннаяЗаметкаБезПробелов'.repeat(12);
  await noteText.fill(longNote);
  const longNoteLayout = await page
    .locator('.replay-note-list button[aria-pressed="true"] span')
    .evaluate((text) => {
      const button = text.closest('button');
      return {
        text: text.textContent,
        height: text.clientHeight,
        lineHeight: Number.parseFloat(window.getComputedStyle(text).lineHeight),
        clipped:
          text.scrollHeight > text.clientHeight + 1 ||
          button.scrollWidth > button.clientWidth + 1,
      };
    });
  assert.equal(longNoteLayout.text, longNote);
  assert.ok(
    longNoteLayout.height > longNoteLayout.lineHeight * 2,
    'timestamped notes must wrap onto multiple lines',
  );
  assert.equal(
    longNoteLayout.clipped,
    false,
    'long timestamped notes must fit without clipping',
  );
  await noteText.fill('Занять плент после флешки');
  await page.waitForFunction(
    () => !document.querySelector('.replay-notes-panel [role="status"]'),
  );
  const textareaBeforeResize = await noteText.boundingBox();
  const mapBeforeResize = await page.locator('.replay-radars').boundingBox();
  await page.mouse.move(
    textareaBeforeResize.x + textareaBeforeResize.width - 3,
    textareaBeforeResize.y + textareaBeforeResize.height - 3,
  );
  await page.mouse.down();
  await page.mouse.move(
    textareaBeforeResize.x + textareaBeforeResize.width - 3,
    textareaBeforeResize.y + textareaBeforeResize.height + 57,
    { steps: 12 },
  );
  await page.mouse.up();
  const resizedTextarea = await noteText.boundingBox();
  assert.ok(
    resizedTextarea.height > textareaBeforeResize.height + 30,
    'note text area must resize with its handle',
  );
  assert.deepEqual(
    await page.locator('.replay-radars').boundingBox(),
    mapBeforeResize,
    'resizing note text must not resize either radar',
  );
  await noteText.evaluate((textarea) => {
    textarea.style.height = '';
  });
  const drawShape = async (tool) => {
    await page.getByRole('button', { name: tool, exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.replay-notes-panel [role="status"]'),
    );
    await page.mouse.move(
      bounds.x + bounds.width - 90,
      bounds.y + bounds.height * 0.55,
    );
    await page.mouse.down();
    const savesBeforeMove = await page.evaluate(() => {
      window.__editorMutations = 0;
      window.__editorMutationObserver = new window.MutationObserver(
        (records) => {
          window.__editorMutations += records.length;
        },
      );
      window.__editorMutationObserver.observe(
        document.querySelector('.replay-notes-panel'),
        {
          attributes: true,
          childList: true,
          subtree: true,
          characterData: true,
        },
      );
      return window.__replayCalls.filter(
        (call) => call.command === 'save_replay_notes',
      ).length;
    });
    await page.mouse.move(
      bounds.x + bounds.width - 30,
      bounds.y + bounds.height * 0.7,
      { steps: 8 },
    );
    await page.evaluate(
      () => new Promise((resolve) => window.requestAnimationFrame(resolve)),
    );
    const drawingWork = await page.evaluate(() => {
      window.__editorMutationObserver.disconnect();
      return {
        mutations: window.__editorMutations,
        saves: window.__replayCalls.filter(
          (call) => call.command === 'save_replay_notes',
        ).length,
      };
    });
    assert.equal(
      drawingWork.mutations,
      0,
      'pointer motion must not rebuild the note editor',
    );
    assert.equal(
      drawingWork.saves,
      savesBeforeMove,
      'drawing previews must not save on pointer motion',
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
  await page.mouse.move(
    bounds.x + bounds.width - 45,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(
    (original) =>
      document
        .querySelector('.replay-annotations > g')
        ?.getAttribute('transform') !== original,
    originalTransform,
  );
  assert.equal(
    await drawing.locator('polyline').getAttribute('points'),
    storedPoints,
  );
  await page.getByRole('button', { name: 'Сбросить вид', exact: true }).click();
  // An unfinished stroke is discarded when the view changes with the wheel.
  await page.mouse.move(
    bounds.x + bounds.width - 90,
    bounds.y + bounds.height * 0.55,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 30,
    bounds.y + bounds.height * 0.7,
    { steps: 4 },
  );
  assert.equal(await drawing.locator('circle').count(), 1);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(
    () => !document.querySelector('.replay-annotations circle'),
  );
  await page.mouse.up();
  assert.equal(
    await drawing.locator('polyline').getAttribute('points'),
    storedPoints,
  );
  await page.waitForTimeout(100);
  const panelCamera = await camera();
  await noteText.hover();
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(100);
  assert.deepEqual(
    await camera(),
    panelCamera,
    'scrolling notes must not zoom the map',
  );
  await page.getByRole('button', { name: 'Сбросить вид', exact: true }).click();
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
  assert.equal(
    await page
      .locator('.replay-round-rail-list button.active .replay-round-note-badge')
      .count(),
    0,
  );
  const secondRoundNoteTick = Number(await timeline.inputValue());
  await noteText.fill('Проверить выход на B');
  assert.equal(
    await page
      .locator('.replay-round-rail-list button.active .replay-round-note-badge')
      .count(),
    1,
  );
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
  assert.equal(
    await drawing.locator('polyline').count(),
    1,
    'closing the editor keeps the selected drawing visible',
  );
  assert.equal(await drawing.getAttribute('class'), 'replay-annotations ');
  await page.getByRole('button', { name: /^Заметки/ }).click();
  await drawing.locator('polyline').waitFor();
  const dockLayout = await page
    .locator('.replay-notes-panel')
    .evaluate((panel) => {
      const p = panel.getBoundingClientRect();
      const map = document
        .querySelector('.replay-radars')
        .getBoundingClientRect();
      return {
        overlaps:
          p.left < map.right &&
          p.right > map.left &&
          p.top < map.bottom &&
          p.bottom > map.top,
      };
    });
  assert.equal(dockLayout.overlaps, false, 'note editor stays outside the map');
  const notesPosition = await page
    .locator('.replay-notes-toggle')
    .evaluate((button) => {
      const b = button.getBoundingClientRect();
      const map = document
        .querySelector('.replay-radars')
        .getBoundingClientRect();
      return { right: map.right - b.right, top: b.top - map.top };
    });
  assert.ok(
    Math.abs(notesPosition.right - 12) <= 1 &&
      Math.abs(notesPosition.top - 12) <= 1,
    'notes button stays at the top right of a single radar',
  );
  await page
    .getByRole('button', { name: 'Показать рисунки', exact: true })
    .click();
  assert.equal(await drawing.locator('polyline').count(), 0);
  await page
    .getByRole('button', { name: 'Показать рисунки', exact: true })
    .click();
  assert.equal(await drawing.locator('polyline').count(), 1);
  const shareScreenshot = page.getByRole('button', {
    name: 'Поделиться скриншотом карты',
    exact: true,
  });
  assert.equal(
    await shareScreenshot.evaluate(
      (button) =>
        button.parentElement.classList.contains('replay-map') &&
        !button.closest('.map-toolbar-floating'),
    ),
    true,
    'screenshot button must be a standalone canvas control outside all toolbars',
  );
  await shareScreenshot.click();
  const screenshotDialog = page.getByRole('dialog', {
    name: 'Поделиться скриншотом карты',
  });
  await screenshotDialog.waitFor();
  const screenshotPixels = await screenshotDialog
    .locator('img')
    .evaluate(async (image) => {
      await image.decode();
      const base = document.querySelector('.replay-map canvas');
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const original = base
        .getContext('2d')
        .getImageData(0, 0, base.width, base.height).data;
      let changed = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i] !== original[i] ||
          pixels[i + 1] !== original[i + 1] ||
          pixels[i + 2] !== original[i + 2]
        )
          changed++;
      return {
        changed,
        width: canvas.width,
        height: canvas.height,
        baseWidth: base.width,
        baseHeight: base.height,
      };
    });
  assert.equal(screenshotPixels.width, screenshotPixels.baseWidth);
  assert.equal(screenshotPixels.height, screenshotPixels.baseHeight);
  assert.ok(
    screenshotPixels.changed > 10,
    'screenshot includes the visible drawing overlay',
  );
  const frozenImage = await screenshotDialog.locator('img').getAttribute('src');
  await screenshotDialog
    .getByRole('button', { name: 'Копировать изображение', exact: true })
    .click();
  await page.waitForFunction(
    () => window.__copiedReplayScreenshot?.length > 100,
  );
  assert.deepEqual(
    await page.evaluate(() => window.__copiedReplayScreenshot.slice(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  await page.evaluate(() => {
    window.__failScreenshotCopy = true;
  });
  await screenshotDialog
    .getByRole('button', { name: 'Копировать изображение', exact: true })
    .click();
  await screenshotDialog.getByRole('alert').waitFor();
  await page.evaluate(() => {
    window.__failScreenshotSave = true;
  });
  await screenshotDialog
    .getByRole('button', { name: 'Сохранить PNG', exact: true })
    .click();
  await screenshotDialog
    .getByRole('alert')
    .filter({ hasText: 'Не удалось сохранить' })
    .waitFor();
  await page.evaluate(() => {
    window.__failScreenshotSave = false;
    window.__cancelScreenshotSave = true;
  });
  await screenshotDialog
    .getByRole('button', { name: 'Сохранить PNG', exact: true })
    .click();
  await screenshotDialog.getByRole('alert').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.__cancelScreenshotSave = false;
  });
  await screenshotDialog
    .getByRole('button', { name: 'Сохранить PNG', exact: true })
    .click();
  const savedScreenshot = await page.evaluate(
    () =>
      window.__replayCalls
        .filter((call) => call.command === 'save_replay_screenshot')
        .at(-1).args,
  );
  assert.match(savedScreenshot.name, /-round-1-main-tick-\d+\.png$/);
  assert.equal(
    Buffer.from(savedScreenshot.png).toString('base64'),
    frozenImage.split(',')[1],
  );
  await screenshotDialog.screenshot({
    path: 'dist/replay-checks/share-map.png',
  });
  await page.keyboard.press('Escape');
  await screenshotDialog.waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: 'Закрыть заметки', exact: true })
    .click();
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
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('.replay-rosters[data-fit="expanded"]').waitFor();
  const expandedRoster = await page
    .locator('.replay-rosters')
    .evaluate((pane) => {
      const bounds = pane.getBoundingClientRect();
      const teams = [...pane.querySelectorAll('.replay-team')].map((team) =>
        team.getBoundingClientRect(),
      );
      const players = [...pane.querySelectorAll('.replay-player')].map(
        (player) => player.getBoundingClientRect(),
      );
      return {
        height: bounds.height,
        teamHeights: teams.map((team) => team.height),
        remaining: bounds.bottom - players.at(-1).bottom,
        overflow: pane.scrollHeight > pane.clientHeight + 1,
      };
    });
  assert.ok(
    expandedRoster.teamHeights.every(
      (height) => Math.abs(height - expandedRoster.height / 2) <= 1,
    ),
    'Full HD roster must split the available height evenly between teams',
  );
  assert.ok(expandedRoster.remaining < 12, 'roster must fill the pane height');
  assert.equal(expandedRoster.overflow, false, 'Full HD roster must fit');
  await page.screenshot({ path: 'dist/replay-checks/fullhd-roster.png' });
  await page.getByRole('button', { name: 'Следующий раунд' }).click();
  await page.getByRole('slider', { name: 'Таймлайн повтора' }).waitFor();
  await page.waitForTimeout(200);
  const timelineGrenade = page
    .locator('.replay-timeline-grenade-marker')
    .first();
  await timelineGrenade.waitFor();
  await timelineGrenade.click({ button: 'right' });
  await page
    .locator('.replay-timeline-grenade-marker.coordinates-copied .lucide-check')
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.__copiedReplayCoordinates),
    rounds.find((r) => r.round_number === 2).grenades[0].data.coordinates,
  );
  const timelineCopyAnimation = await timelineGrenade.evaluate((marker) => ({
    duration: Number.parseFloat(
      window.getComputedStyle(marker.querySelector('button')).animationDuration,
    ),
    ring: window.getComputedStyle(marker, '::after').animationName,
  }));
  assert.ok(timelineCopyAnimation.duration >= 0.4);
  assert.equal(timelineCopyAnimation.ring, 'coordinates-copy-ring');
  await page.setViewportSize({ width: 760, height: 560 });
  const compactSettings = await settings.boundingBox();
  assert.ok(
    compactSettings.x >= 0 && compactSettings.x + compactSettings.width <= 750,
    'replay settings button must fit fully inside the compact window',
  );
  await settings.click();
  await page.getByRole('menu').waitFor();
  for (const label of ['Фризтайм', 'Автоследующий раунд']) {
    await page
      .getByRole('menu')
      .getByText(label, { exact: true })
      .waitFor({ state: 'visible' });
  }
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'dist/replay-checks/compact.png' });
  const compactTeamLabels = await page
    .locator(
      '.replay-match-score > .replay-side-t, .replay-match-score > .replay-side-ct',
    )
    .evaluateAll((labels) =>
      labels.map((label) => ({
        text: label.textContent?.trim(),
        display: window.getComputedStyle(label).display,
        width: label.getBoundingClientRect().width,
      })),
    );
  assert.equal(compactTeamLabels.length, 2);
  assert.ok(
    compactTeamLabels.every(
      (label) => label.display !== 'none' && label.text && label.width > 0,
    ),
    JSON.stringify(compactTeamLabels),
  );
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
  const notesPanel = page.getByRole('complementary', {
    name: 'Все заметки реплеев',
    exact: true,
  });
  await notesPanel
    .getByRole('heading', { name: 'Раунд 1', exact: true })
    .waitFor();
  await notesPanel
    .getByRole('heading', { name: 'Раунд 2', exact: true })
    .waitFor();
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 2);
  const searchNotes = page.getByRole('textbox', {
    name: 'Поиск заметок',
    exact: true,
  });
  await searchNotes.fill('выход на B');
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await searchNotes.fill('ничего не найдено');
  await notesPanel.getByText('Заметки не найдены', { exact: true }).waitFor();
  await searchNotes.fill('');
  await notesPanel
    .getByRole('link', { name: /^Открыть заметку: Раунд 2/ })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.replay-round-rail-list button[aria-current] span',
      )?.textContent === 'R2',
  );
  await noteText.waitFor();
  assert.equal(await noteText.inputValue(), 'Проверить выход на B');
  assert.equal(Number(await timeline.inputValue()), secondRoundNoteTick);
  await page.getByRole('button', { name: 'История матчей' }).click();
  await notesPanel
    .getByRole('link', { name: /^Открыть заметку: Раунд 1/ })
    .click();
  await noteText.waitFor();
  assert.equal(
    (await noteText.inputValue()).trim(),
    'Занять плент после флешки',
  );
  assert.equal(
    await drawing.locator('polyline').getAttribute('points'),
    storedPoints,
  );
  assert.equal(Number(await timeline.inputValue()), noteTick);
  await page
    .getByRole('button', { name: 'Удалить заметку', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.replay-round-rail-list button.active .replay-round-note-badge')
      .count(),
    0,
    'deleting the last note removes its round badge',
  );
  await page.getByRole('button', { name: 'История матчей' }).click();
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await page.setViewportSize({ width: 760, height: 560 });
  await page.screenshot({
    path: 'dist/replay-checks/history-notes-compact.png',
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__setSecondReplay(true));
  storedNotes.push({
    replay_id: 2,
    note: {
      id: 'second-match-drawing',
      round: 3,
      tick: rounds[3].round.freeze_end_tick + 128,
      lower: false,
      text: '',
      strokes: [
        {
          tool: 'circle',
          color: '#123abc',
          points: [
            [100, 100],
            [150, 150],
          ],
        },
      ],
    },
    round_summary: rounds[3].round,
    updated_at: Date.now() + 1000,
  });
  await page.reload();
  await notesPanel.locator('.replay-history-note').nth(1).waitFor();
  assert.equal(
    await notesPanel.locator('.replay-history-note').count(),
    2,
    'all matches must be shown by default',
  );
  assert.ok(
    (
      await notesPanel.locator('.replay-history-note').first().textContent()
    ).includes('second-replay.dem'),
    'recent edits appear first',
  );
  const chooseNoteFilter = async (label, option) => {
    await notesPanel
      .getByRole('combobox', { name: label, exact: true })
      .click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await chooseNoteFilter('Тип заметки', 'С рисунками');
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  assert.ok(
    (await notesPanel.locator('.replay-history-note').textContent()).includes(
      'second-replay.dem',
    ),
  );
  await chooseNoteFilter('Тип заметки', 'С текстом');
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await chooseNoteFilter('Тип заметки', 'Текст и рисунки');
  await notesPanel.getByText('Заметки не найдены', { exact: true }).waitFor();
  await notesPanel
    .getByRole('button', { name: 'Сбросить фильтры', exact: true })
    .click();
  await chooseNoteFilter('Карта', 'Inferno');
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await chooseNoteFilter('Раунд', 'Раунд 3');
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await searchNotes.fill('second-replay');
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await searchNotes.fill('не существует');
  await notesPanel.getByText('Заметки не найдены', { exact: true }).waitFor();
  await notesPanel
    .getByRole('button', { name: 'Сбросить фильтры', exact: true })
    .click();
  await chooseNoteFilter('Сортировка заметок', 'Матч, раунд и время');
  await chooseNoteFilter('Реплей', `${metadata.demo_filename} ${metadata.map}`);
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await notesPanel
    .getByRole('button', { name: 'Сбросить фильтры', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'Заметки матча second-replay.dem: 1',
      exact: true,
    })
    .click();
  assert.equal(await notesPanel.locator('.replay-history-note').count(), 1);
  await notesPanel
    .getByRole('link', { name: /^Открыть заметку: Раунд 3/ })
    .click();
  await noteText.waitFor();
  assert.equal(new URL(page.url()).pathname, '/replays/2');
  assert.equal(await drawing.locator('circle').count(), 1);
  await page
    .getByRole('button', { name: 'Удалить заметку', exact: true })
    .click();
  await page.getByRole('button', { name: 'История матчей' }).click();
  await page
    .getByRole('button', {
      name: 'Заметки матча second-replay.dem: 0',
      exact: true,
    })
    .click();
  await notesPanel.getByText('Заметки не найдены', { exact: true }).waitFor();
  await page
    .getByRole('button', {
      name: `Заметки матча ${metadata.demo_filename}: 1`,
      exact: true,
    })
    .click();
  assert.equal(
    await notesPanel.locator('.replay-history-note').count(),
    1,
    'notes from another replay must not leak into the selected match',
  );
  await page.screenshot({ path: 'dist/replay-checks/history-notes.png' });
  await page.evaluate(() => window.__setSecondReplay(false));
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
  const diagnostics = page.locator('.replay-error-report');
  assert.match(await diagnostics.innerText(), /\[Replay parser job\]/);
  await page.getByRole('button', { name: 'Скопировать диагностику' }).click();
  assert.equal(
    await page.evaluate(() => window.__copiedReplayCoordinates),
    await diagnostics.innerText(),
  );
  const failedReplayPage = await context.newPage();
  const diagnosticConsole = [];
  failedReplayPage.on('console', (message) => {
    if (message.type() === 'error') diagnosticConsole.push(message.text());
  });
  await failedReplayPage.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'get_replay')
        return Promise.reject('Query returned no rows');
      return original(command, args);
    };
  });
  await failedReplayPage.goto('http://127.0.0.1:1428/replays/1');
  const diagnosticReport = failedReplayPage.locator('.replay-error-report');
  await diagnosticReport.waitFor();
  const report = await diagnosticReport.innerText();
  for (const expected of [
    'command: get_replay',
    'arguments: {"id":1}',
    'Query returned no rows',
  ]) {
    assert.ok(report.includes(expected), report);
  }
  assert.ok(diagnosticConsole.some((message) => message.includes(report)));
  await failedReplayPage.close();
  const missingReplayPage = await context.newPage();
  const missingReplayErrors = [];
  missingReplayPage.on('pageerror', (error) => errors.push(error.message));
  missingReplayPage.on('console', (message) => {
    if (message.type() === 'error') missingReplayErrors.push(message.text());
  });
  await missingReplayPage.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'get_replay') return Promise.resolve(null);
      return original(command, args);
    };
  });
  await missingReplayPage.goto('http://127.0.0.1:1428/replays/999');
  await missingReplayPage.waitForURL('http://127.0.0.1:1428/replays');
  await missingReplayPage
    .getByText('Сохранённого повтора больше нет. Открой демо заново.')
    .waitFor();
  assert.equal(
    await missingReplayPage.locator('.replay-error').count(),
    0,
    await missingReplayPage
      .locator('.replay-error')
      .allTextContents()
      .then((items) => items.join('\n')),
  );
  assert.deepEqual(missingReplayErrors, []);
  await missingReplayPage.close();
  const notesBeforeBulkDelete = JSON.parse(JSON.stringify(storedNotes));
  const bulkDeletePage = await context.newPage();
  bulkDeletePage.on('pageerror', (error) => errors.push(error.message));
  await bulkDeletePage.addInitScript(() => {
    window.__setSecondReplay(true);
    const original = window.__TAURI_INTERNALS__.invoke;
    let failOnce = true;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'delete_replays' && failOnce) {
        failOnce = false;
        throw new Error('Test deletion failed');
      }
      return original(command, args);
    };
  });
  await bulkDeletePage.goto('http://127.0.0.1:1428/replays');
  await bulkDeletePage.locator('.replay-match-row').nth(1).waitFor();
  const selectAll = bulkDeletePage.getByRole('button', {
    name: 'Выбрать все матчи',
    exact: true,
  });
  await selectAll.click();
  assert.equal(
    await bulkDeletePage
      .locator('.replay-match-select[aria-pressed="true"]')
      .count(),
    2,
  );
  await selectAll.click();
  assert.equal(
    await bulkDeletePage
      .locator('.replay-match-select[aria-pressed="true"]')
      .count(),
    0,
  );
  await bulkDeletePage
    .getByRole('button', {
      name: 'Выбрать матч second-replay.dem',
      exact: true,
    })
    .click();
  await bulkDeletePage
    .getByRole('button', { name: /^Удалить выбранные/ })
    .click();
  const bulkDialog = bulkDeletePage.getByRole('dialog');
  await bulkDialog
    .getByRole('heading', { name: 'Удалить выбранные матчи?' })
    .waitFor();
  await bulkDialog
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  await bulkDialog
    .getByRole('alert')
    .filter({ hasText: 'Test deletion failed' })
    .waitFor();
  assert.equal(await bulkDeletePage.locator('.replay-match-row').count(), 2);
  await bulkDialog
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  await bulkDeletePage.waitForFunction(
    () => document.querySelectorAll('.replay-match-row').length === 1,
  );
  assert.deepEqual(
    await bulkDeletePage.evaluate(() =>
      window.__replayCalls
        .filter((call) => call.command === 'delete_replays')
        .map((call) => call.args.ids),
    ),
    [[2]],
  );
  assert.equal(
    await bulkDeletePage
      .locator('.replay-match-select[aria-pressed="true"]')
      .count(),
    0,
  );
  await bulkDeletePage
    .getByRole('button', { name: 'Очистить базу', exact: true })
    .click();
  await bulkDialog
    .getByRole('heading', { name: 'Очистить базу реплеев?' })
    .waitFor();
  await bulkDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await bulkDeletePage.locator('.replay-match-row').count(), 1);
  await bulkDeletePage
    .getByRole('button', { name: 'Очистить базу', exact: true })
    .click();
  await bulkDialog
    .getByRole('button', { name: 'Очистить базу', exact: true })
    .click();
  await bulkDeletePage
    .getByRole('heading', { name: 'Нет сохранённых матчей' })
    .waitFor();
  assert.equal(
    await bulkDeletePage.evaluate(
      () =>
        window.__replayCalls.filter((call) => call.command === 'clear_replays')
          .length,
    ),
    1,
  );
  await bulkDeletePage.evaluate(() =>
    localStorage.removeItem('replay-test-second-match'),
  );
  await bulkDeletePage.close();
  storedNotes = notesBeforeBulkDelete;
  const notesBeforeReparse = JSON.parse(JSON.stringify(storedNotes));
  const reparsePage = await context.newPage();
  reparsePage.on('pageerror', (error) => errors.push(error.message));
  await reparsePage.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    let savedEntries;
    let available = true;
    let completed = false;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'list_replays') {
        savedEntries ??= await original(command, args);
        return available ? savedEntries : [];
      }
      if (command === 'get_nade_parser_status' && completed)
        return {
          running: false,
          stage: 'complete',
          output: 'replay:1',
          error: null,
          completed: 2,
        };
      if (command === 'start_replay') {
        await original(command, args);
        completed = true;
        available = true;
        return null;
      }
      if (command === 'delete_replay') available = false;
      if (command === 'get_replay' && !available) return null;
      return original(command, args);
    };
  });
  await reparsePage.goto('http://127.0.0.1:1428/replays');
  for (let attempt = 0; attempt < 2; attempt++) {
    await reparsePage
      .getByRole('button', { name: 'Открыть демо', exact: true })
      .click();
    await reparsePage.waitForURL('http://127.0.0.1:1428/replays/1');
    await reparsePage
      .getByRole('button', { name: 'Воспроизвести', exact: true })
      .waitFor();
    assert.equal(await reparsePage.locator('.replay-error').count(), 0);
    await reparsePage.getByRole('button', { name: 'История матчей' }).click();
    if (attempt === 0) {
      await reparsePage
        .getByRole('button', { name: 'Удалить матч', exact: true })
        .click();
      await reparsePage
        .getByRole('button', { name: 'Удалить', exact: true })
        .click();
      await reparsePage
        .getByRole('heading', { name: 'Нет сохранённых матчей' })
        .waitFor();
    }
  }
  await reparsePage.close();
  storedNotes = notesBeforeReparse;
  const failedNotesPage = await context.newPage();
  failedNotesPage.on('pageerror', (error) => errors.push(error.message));
  await failedNotesPage.addInitScript(() => {
    window.__failReplayNotesLoad = true;
  });
  await failedNotesPage.goto('http://127.0.0.1:1428/replays/1');
  await failedNotesPage.getByRole('button', { name: /^Заметки/ }).click();
  const failedNotesAlert = failedNotesPage
    .getByRole('alert')
    .filter({ hasText: 'Не удалось загрузить или сохранить заметки.' });
  await failedNotesAlert.waitFor();
  assert.equal(
    await failedNotesPage
      .getByRole('textbox', { name: 'Текст заметки' })
      .isDisabled(),
    true,
    'editing is blocked until existing notes have loaded',
  );
  assert.equal(
    await failedNotesPage.evaluate(
      () =>
        window.__replayCalls.filter(
          (call) => call.command === 'save_replay_notes',
        ).length,
    ),
    0,
    'a failed read must never overwrite stored notes with an empty snapshot',
  );
  await failedNotesPage.evaluate(() => {
    window.__failReplayNotesLoad = false;
  });
  await failedNotesAlert
    .getByRole('button', { name: 'Повторить', exact: true })
    .click();
  await failedNotesAlert.waitFor({ state: 'hidden' });
  await failedNotesPage.getByRole('button', { name: 'История матчей' }).click();
  await failedNotesPage.locator('.replay-history-note').waitFor();
  assert.equal(
    await failedNotesPage.locator('.replay-history-note').count(),
    1,
  );
  await failedNotesPage.close();
  await page.getByRole('button', { name: 'Удалить матч', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('heading', { name: 'Нет сохранённых матчей' }).waitFor();
  assert.equal(
    storedNotes.length,
    0,
    'deleting a match removes its SQLite notes',
  );
  const failedRadarPage = await context.newPage();
  failedRadarPage.on('pageerror', (e) => errors.push(e.message));
  await failedRadarPage.route('**/*_radar_psd.png', (route) => route.abort());
  await failedRadarPage.goto('http://127.0.0.1:1428/replays/1');
  await failedRadarPage
    .getByText('Радар этой карты недоступен', { exact: true })
    .waitFor();
  await failedRadarPage.close();
  if (!records) {
    // Two Nuke views share a clock while keeping cameras and note editors separate.
    const nukePage = await context.newPage();
    nukePage.on('pageerror', (error) => errors.push(error.message));
    await nukePage.goto('http://127.0.0.1:1428/replays');
    await nukePage.evaluate(() =>
      localStorage.setItem('replay-test-map', 'nuke'),
    );
    await nukePage.goto('http://127.0.0.1:1428/replays/1');
    const mainRadar = nukePage.getByRole('region', {
      name: 'Основной радар',
      exact: true,
    });
    const lowerRadar = nukePage.getByRole('region', {
      name: 'Нижний радар',
      exact: true,
    });
    const mainCanvas = mainRadar.locator('canvas');
    const lowerCanvas = lowerRadar.locator('canvas');
    await nukePage.waitForFunction(
      () =>
        [...document.querySelectorAll('canvas')].length === 2 &&
        [...document.querySelectorAll('canvas')].every(
          (canvas) => canvas.dataset.camera,
        ),
    );
    assert.equal(
      await nukePage.getByRole('group', { name: 'Этаж', exact: true }).count(),
      0,
    );
    assert.equal(await nukePage.locator('.replay-killfeed').count(), 1);
    const paneCamera = (canvas) =>
      canvas.evaluate((element) => JSON.parse(element.dataset.camera));
    const mainBefore = await paneCamera(mainCanvas);
    const lowerBefore = await paneCamera(lowerCanvas);
    assert.deepEqual(
      await mainCanvas.evaluate((canvas) =>
        JSON.parse(canvas.dataset.playerNames),
      ),
      ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5'],
    );
    assert.deepEqual(
      await lowerCanvas.evaluate((canvas) =>
        JSON.parse(canvas.dataset.playerNames),
      ),
      ['Player 6', 'Player 7', 'Player 8', 'Player 9', 'Player 10'],
    );
    await mainCanvas.hover();
    await nukePage.mouse.wheel(0, -100);
    await nukePage.waitForTimeout(100);
    assert.ok((await paneCamera(mainCanvas))[2] > mainBefore[2]);
    assert.deepEqual(await paneCamera(lowerCanvas), lowerBefore);
    const mainZoomed = await paneCamera(mainCanvas);
    await lowerCanvas.hover();
    await nukePage.mouse.wheel(0, -100);
    await nukePage.waitForTimeout(100);
    assert.ok((await paneCamera(lowerCanvas))[2] > lowerBefore[2]);
    assert.deepEqual(await paneCamera(mainCanvas), mainZoomed);
    const nukeTimeline = nukePage.getByRole('slider', {
      name: 'Таймлайн повтора',
    });
    const seekNuke = async (tick) => {
      await nukeTimeline.evaluate((slider, value) => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set.call(slider, String(value));
        slider.dispatchEvent(new window.Event('input', { bubbles: true }));
      }, tick);
    };
    const nukeTick = Number(await nukeTimeline.inputValue());
    await lowerCanvas.focus();
    await nukePage.keyboard.press('ArrowRight');
    assert.equal(Number(await nukeTimeline.inputValue()), nukeTick + seekStep);
    await mainCanvas.focus();
    await nukePage.keyboard.press('ArrowRight');
    await nukePage.keyboard.down('ArrowRight');
    await nukePage.keyboard.down('ArrowRight');
    await nukePage.keyboard.up('ArrowRight');
    assert.equal(
      Number(await nukeTimeline.inputValue()),
      nukeTick + 4 * seekStep,
      'holding an arrow repeats five-second seeks',
    );
    await seekNuke(Number(await nukeTimeline.getAttribute('max')));
    const endTick = Number(await nukeTimeline.inputValue());
    await mainCanvas.focus();
    await nukePage.keyboard.press('ArrowRight');
    assert.equal(Number(await nukeTimeline.inputValue()), endTick);
    assert.equal(
      await nukePage
        .locator('.replay-round-rail-list button[aria-current] > span')
        .first()
        .textContent(),
      'R1',
    );
    await seekNuke(nukeTick);

    assert.equal(
      await nukePage.locator('.replay-notes-toggle').count(),
      1,
      'both Nuke floors use one shared notes button',
    );
    await nukePage
      .getByRole('button', { name: 'Заметки', exact: true })
      .click();
    const nukeNoteText = nukePage.getByRole('textbox', {
      name: 'Текст заметки',
    });
    const commonNotesList = nukePage.locator('.replay-note-list');
    for (const [pane, text] of [
      [mainRadar, 'Верхний этаж Nuke'],
      [lowerRadar, 'Нижний этаж Nuke'],
    ]) {
      await pane
        .getByRole('button', { name: 'Сбросить вид', exact: true })
        .click();
      const rect = await pane.locator('canvas').boundingBox();
      await nukePage.mouse.move(
        rect.x + rect.width - 45,
        rect.y + rect.height * 0.55,
      );
      await nukePage.mouse.down();
      await nukePage.mouse.move(
        rect.x + rect.width - 15,
        rect.y + rect.height * 0.7,
        { steps: 5 },
      );
      await nukePage.mouse.up();
      await nukeNoteText.fill(text);
      assert.equal(
        await pane.locator('.replay-annotations polyline').count(),
        1,
      );
    }
    assert.equal(await nukePage.locator('.replay-notes-panel').count(), 1);
    assert.match(await commonNotesList.textContent(), /Верхний этаж Nuke/);
    assert.match(await commonNotesList.textContent(), /Нижний этаж Nuke/);
    assert.equal(
      await mainRadar.locator('.replay-annotations polyline').count(),
      0,
      'a selected lower-floor drawing must not be duplicated on the main radar',
    );
    await nukePage
      .getByRole('button', { name: 'Отменить рисунок', exact: true })
      .click();
    assert.equal(
      await lowerRadar.locator('.replay-annotations polyline').count(),
      0,
      'the shared undo button edits the selected floor',
    );
    // Restore a lower-floor stroke with the same shared toolbar.
    const lowerRect = await lowerCanvas.boundingBox();
    await nukePage.mouse.move(
      lowerRect.x + lowerRect.width - 45,
      lowerRect.y + lowerRect.height * 0.55,
    );
    await nukePage.mouse.down();
    await nukePage.mouse.move(
      lowerRect.x + lowerRect.width - 15,
      lowerRect.y + lowerRect.height * 0.7,
      { steps: 5 },
    );
    await nukePage.mouse.up();
    await nukePage.waitForFunction(
      () => !document.querySelector('.replay-notes-panel [role="status"]'),
    );
    assert.equal(storedNotes.length, 2);
    const lowerNote = storedNotes.find((item) => item.note.lower).note;
    await lowerRadar
      .getByRole('button', { name: 'Поделиться скриншотом карты', exact: true })
      .click();
    const lowerScreenshot = nukePage.getByRole('dialog', {
      name: 'Поделиться скриншотом карты',
    });
    await lowerScreenshot.waitFor();
    assert.match(
      await lowerScreenshot
        .locator('#replay-screenshot-description')
        .textContent(),
      /Нижний/,
    );
    const floorPixels = await lowerScreenshot
      .locator('img')
      .evaluate(async (image) => {
        await image.decode();
        const lower = document.querySelector('[data-floor="lower"] canvas');
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          lowerWidth: lower.width,
          lowerHeight: lower.height,
        };
      });
    assert.equal(floorPixels.width, floorPixels.lowerWidth);
    assert.equal(floorPixels.height, floorPixels.lowerHeight);
    await nukePage.keyboard.press('Escape');
    await lowerScreenshot.waitFor({ state: 'hidden' });
    assert.equal(
      storedNotes.find((item) => !item.note.lower).note.text,
      'Верхний этаж Nuke',
    );
    await nukePage.goto(`http://127.0.0.1:1428/replays/1?note=${lowerNote.id}`);
    await nukeNoteText.waitFor();
    assert.equal(await nukeNoteText.inputValue(), 'Нижний этаж Nuke');
    assert.equal(
      await lowerRadar.locator('.replay-annotations polyline').count(),
      1,
    );
    assert.equal(
      await nukePage.locator('.replay-notes-panel').count(),
      1,
      'note links open the common editor',
    );
    await commonNotesList
      .getByRole('button', { name: /Верхний этаж Nuke/ })
      .click();
    assert.equal(await nukeNoteText.inputValue(), 'Верхний этаж Nuke');
    assert.equal(
      await mainRadar.locator('.replay-annotations polyline').count(),
      1,
    );
    assert.equal(
      await lowerRadar.locator('.replay-annotations polyline').count(),
      0,
    );
    await nukePage
      .getByRole('button', { name: 'Закрыть заметки', exact: true })
      .click();
    assert.equal(
      await nukePage.locator('.replay-annotations.is-drawing').count(),
      0,
      'closing shared notes stops drawing on both floors',
    );
    assert.equal(
      await mainRadar.locator('.replay-annotations polyline').count(),
      1,
      'closing the shared editor keeps the selected floor drawing visible',
    );
    const burstStart = first.round.freeze_end_tick + metadata.tickrate * 30;
    await seekNuke(burstStart + metadata.tickrate);
    const burstRows = nukePage.locator('.replay-killfeed-row');
    assert.equal(await burstRows.count(), 5);
    assert.deepEqual(
      await burstRows.evaluateAll((rows) =>
        rows.map((row) => Number(row.dataset.tick)),
      ),
      Array.from(
        { length: 5 },
        (_, index) => burstStart + metadata.tickrate * ((index + 2) / 8),
      ),
      'overflow retains the latest five kills in chronological order',
    );
    await nukePage
      .getByRole('button', { name: 'Настройки реплея', exact: true })
      .click();
    const speedBeforeMenu = await nukePage
      .locator('.replay-speeds [aria-pressed="true"]')
      .textContent();
    await nukePage.keyboard.press('ArrowUp');
    assert.equal(
      await nukePage
        .locator('.replay-speeds [aria-pressed="true"]')
        .textContent(),
      speedBeforeMenu,
    );
    await nukePage.keyboard.press('Escape');
    for (const width of [1920, 1280, 860]) {
      await nukePage.setViewportSize({ width, height: 900 });
      const upper = await mainRadar.boundingBox();
      const lower = await lowerRadar.boundingBox();
      assert.ok(Math.abs(upper.width - lower.width) <= 1);
      assert.ok(Math.abs(upper.y - lower.y) <= 1 && upper.x < lower.x);
      assert.ok(upper.width > 100 && upper.height > 200);
      const rightCanvasBounds = await lowerRadar
        .locator('canvas')
        .boundingBox();
      for (const pane of [mainRadar, lowerRadar]) {
        const notesButton = await nukePage
          .locator('.replay-notes-toggle')
          .boundingBox();
        const zoomTools = await pane.locator('.replay-map-tools').boundingBox();
        const screenshotTools = await pane
          .locator('.replay-screenshot-button')
          .boundingBox();
        const canvasBounds = await pane.locator('canvas').boundingBox();
        const feed = await nukePage.locator('.replay-killfeed').boundingBox();
        assert.ok(
          notesButton.y + notesButton.height <= feed.y,
          'notes controls must clear the killfeed',
        );
        assert.ok(
          Math.abs(
            rightCanvasBounds.x +
              rightCanvasBounds.width -
              notesButton.x -
              notesButton.width -
              12,
          ) <= 1 && Math.abs(notesButton.y - rightCanvasBounds.y - 12) <= 1,
          'Nuke notes button stays at the top right of the radar area',
        );
        assert.ok(
          notesButton.x + notesButton.width <= zoomTools.x ||
            notesButton.y + notesButton.height <= zoomTools.y,
          'notes and zoom controls must not overlap',
        );
        assert.ok(
          notesButton.y + notesButton.height <= screenshotTools.y,
          'notes and screenshot controls must not overlap',
        );
        assert.ok(
          Math.abs(screenshotTools.x - canvasBounds.x - 14) <= 1,
          'screenshot button stays at the left edge of each canvas',
        );
        assert.ok(
          Math.abs(
            canvasBounds.y +
              canvasBounds.height -
              screenshotTools.y -
              screenshotTools.height -
              14,
          ) <= 1,
          'screenshot button stays at the bottom edge of each canvas',
        );
      }
      assert.equal(
        await nukePage.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      await nukePage.screenshot({
        path: `dist/replay-checks/nuke-${width}.png`,
      });
    }
    await nukePage.route('**/*_lower_radar_psd.png', (route) => route.abort());
    await nukePage.reload();
    await lowerRadar
      .getByText('Радар этой карты недоступен', { exact: true })
      .waitFor();
    assert.equal(await mainRadar.locator('.replay-map-missing').count(), 0);
    await nukePage.evaluate(() =>
      localStorage.setItem('replay-test-map', 'vertigo'),
    );
    await nukePage.goto('http://127.0.0.1:1428/replays/1');
    await nukePage.getByRole('group', { name: 'Этаж', exact: true }).waitFor();
    assert.equal(
      await nukePage.locator('canvas').count(),
      1,
      'Vertigo keeps its floor switch',
    );
    await nukePage.addInitScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        const result = await original(command, args);
        if (command === 'get_replay' && result) {
          result.metadata.incomplete = true;
          result.rounds = Array.from({ length: 40 }, (_, index) => ({
            ...result.rounds[1],
            number: index + 1,
          }));
        }
        return result;
      };
    });
    await nukePage.reload();
    await nukePage
      .locator('.replay-round-rail-list button')
      .nth(39)
      .waitFor({ state: 'attached' });
    for (const width of [1280, 860, 760]) {
      await nukePage.setViewportSize({ width, height: 720 });
      const settingsButton = nukePage.getByRole('button', {
        name: 'Настройки реплея',
        exact: true,
      });
      const bounds = await settingsButton.boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width - 10,
        `settings must fit with 40 rounds, incomplete badge and floor switch at ${width}px`,
      );
      await settingsButton.click();
      const menu = nukePage.getByRole('menu');
      await menu.waitFor();
      const menuBounds = await menu.boundingBox();
      assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width);
      for (const label of ['Фризтайм', 'Автоследующий раунд']) {
        const text = menu.getByText(label, { exact: true });
        await text.waitFor({ state: 'visible' });
        const textBounds = await text.boundingBox();
        assert.ok(
          textBounds.width > 0 &&
            textBounds.x + textBounds.width <= menuBounds.x + menuBounds.width,
          `setting label must fit at ${width}px`,
        );
      }
      await nukePage.keyboard.press('Escape');
    }
    await nukePage.evaluate(() => localStorage.removeItem('replay-test-map'));
    await nukePage.close();
  }
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
