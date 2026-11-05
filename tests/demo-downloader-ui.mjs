/* global window, document, localStorage, console */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { port: 1431, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem('nadeviewer.locale', 'ru');
    const query = { start: null, end: null, min_prize: null, max_prize: null };
    const state = {
      events: [
        {
          id: 8932,
          name: 'Thunderpick World Championship 2026',
          prize: 1000000,
          teams: '8',
          kind: 'Intl. LAN',
          location: 'Malta',
          start_date: '2026-10-14',
          end_date: '2026-10-18',
          player_share: 500000,
          club_share: 500000,
          url: 'https://www.hltv.org/events/8932/thunderpick-world-championship-2026',
          status: 'finished',
        },
        {
          id: 8050,
          name: 'PGL Masters Bucharest 2026',
          prize: 1250000,
          teams: '16',
          kind: 'Intl. LAN',
          location: 'Bucharest, Romania',
          start_date: '2026-10-24',
          end_date: '2026-10-31',
          player_share: 625000,
          club_share: 625000,
          url: 'https://www.hltv.org/events/8050/pgl-masters-bucharest-2026',
          status: 'finished',
        },
        {
          id: 1,
          name: 'Online Cup',
          prize: 25000,
          teams: '16',
          kind: 'Online',
          location: 'Europe',
          start_date: '2026-10-01',
          end_date: '2026-10-02',
          player_share: null,
          club_share: null,
          url: 'https://www.hltv.org/events/1/cup',
          status: 'finished',
        },
      ],
      jobs: [],
      updated_at: Date.now() / 1000,
      query,
      destination: '',
      phase: 'idle',
      current: '',
      bytes: 0,
      error: null,
      catalog_complete: true,
    };
    window.__downloadCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (p) => p,
      async invoke(command, args) {
        window.__downloadCalls.push({ command, args });
        if (command.startsWith('plugin:')) return null;
        switch (command) {
          case 'get_demo_downloader':
            return state;
          case 'select_demo_destination':
            return 'F:\\Demos';
          case 'start_demo_downloads':
            state.phase = 'downloading';
            state.current = 'Thunderpick';
            state.bytes = 120000000;
            return null;
          case 'stop_demo_downloads':
            state.phase = 'stopped';
            return null;
          case 'refresh_demo_catalog':
            state.query = args.query;
            state.updated_at = Date.now() / 1000;
            return null;
          case 'get_onboarding_state':
            return { completed: true };
          case 'get_active_import':
          case 'check_library_update':
            return null;
          case 'list_imports':
          case 'get_favorite_maps':
            return [];
          case 'get_favorites_state':
            return {
              collections: [],
              maps: [],
              favorites: {},
              source_matches: {},
            };
          case 'get_nade_parser_info':
            return { installed: false, path: null, version: null };
          default:
            return null;
        }
      },
    };
  });
  await page.goto('http://127.0.0.1:1431/tools/demo-downloader');
  await page.getByRole('heading', { name: 'Скачивание демо' }).waitFor();
  await page
    .getByRole('cell', { name: 'PGL Masters Bucharest 2026', exact: true })
    .waitFor();
  assert.equal(await page.locator('.demo-table tbody tr').count(), 3);
  await page.getByRole('textbox', { name: 'Найти турнир' }).fill('Thunderpick');
  assert.equal(await page.locator('.demo-table tbody tr').count(), 1);
  await page
    .getByRole('checkbox', {
      name: 'Thunderpick World Championship 2026',
      exact: true,
    })
    .check();
  const run = page.getByRole('button', { name: 'Скачать выбранные' });
  assert.equal(await run.isDisabled(), true);
  await page.getByRole('button', { name: 'Выбрать папку' }).click();
  await run.click();
  await page.getByRole('button', { name: 'Остановить' }).waitFor();
  const call = await page.evaluate(() =>
    window.__downloadCalls.find((c) => c.command === 'start_demo_downloads'),
  );
  assert.deepEqual(call.args.urls, [
    'https://www.hltv.org/events/8932/thunderpick-world-championship-2026',
  ]);
  assert.equal(call.args.destination, 'F:\\Demos');
  await page.getByRole('button', { name: 'Остановить' }).click();
  await page.getByRole('textbox', { name: 'Найти турнир' }).fill('');
  await mkdir('artifacts/downloader-qa', { recursive: true });
  await page.screenshot({
    path: 'artifacts/downloader-qa/catalog.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 800 });
  await page.screenshot({
    path: 'artifacts/downloader-qa/narrow.png',
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Demo downloader UI: filtering, selection, destination, start, stop and narrow layout passed.',
  );
} finally {
  await browser.close();
  await server.close();
}
