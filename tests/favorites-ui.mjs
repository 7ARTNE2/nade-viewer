// Isolated browser regression checks; all native commands use an in-memory fixture.
// node tests/favorites-ui.mjs [absolute path to a Playwright package directory]
/* global window, document, navigator, localStorage, console */
import assert from 'node:assert/strict';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = process.argv[2]
  ? await import(pathToFileURL(`${process.argv[2]}/index.mjs`).href)
  : await import('playwright');
const server = await createServer({ server: { port: 1427, strictPort: true } });
await server.listen();
let browser;
let page;
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.NADE_VIEWER_TEST_BROWSER,
    executablePath: process.env.NADE_VIEWER_TEST_BROWSER_PATH,
  });
  const context = await browser.newContext({
    viewport: { width: 900, height: 650 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    localStorage.setItem('nadeviewer.locale', 'ru');
    const detail = (id) => ({
      id,
      favorite_id: id,
      map: 'de_mirage',
      side: 'T',
      grenade_type: 'smoke',
      thrower: `Player ${id}`,
      coordinates: 'setpos 1 2 3; setang 10 20 0',
      throw_keys: 'M1+JUMP',
      usage_count: 4,
      round_time_seconds: 42,
      airtime: 1.5,
      start_map_x: 20,
      start_map_y: 30,
      explode_map_x: 50,
      explode_map_y: 60,
      explode_radar_level: 'default',
      trajectory_preview: [
        [20, 30],
        [50, 60],
      ],
      usage_throwers: ['Player'],
      usage_stats: { tracked_throws: 1, peak: 1, history: [] },
      saved_at: '2026-10-13T00:00:00Z',
      source_label: 'Test library',
      collection_ids: [],
    });
    const model = {
      favorites: Object.fromEntries(
        Array.from({ length: 36 }, (_, i) => [i + 1, detail(i + 1)]),
      ),
      collections: [{ id: 1, name: 'Тренировка Mirage', grenade_count: 0 }],
      calls: [],
      failNext: null,
      nextCollection: 2,
      active: null,
    };
    window.__favoritesFixture = model;
    let callback = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => ++callback,
      unregisterCallback() {},
      convertFileSrc: (path) => path,
      async invoke(command, args) {
        model.calls.push({ command, args });
        if (model.failNext === command) {
          model.failNext = null;
          throw new Error('Test failure');
        }
        if (command.startsWith('plugin:'))
          return command.endsWith('listen') ? 1 : null;
        switch (command) {
          case 'initialize_application':
          case 'report_startup_timing':
            return null;
          case 'get_active_import':
            return model.active;
          case 'list_imports':
            return model.active ? [model.active] : [];
          case 'get_spawn_points':
          case 'get_import_players':
          case 'get_import_tournaments':
            return [];
          case 'get_site_settings':
            return { public_min_usage_count: 1 };
          case 'get_maps':
            return [
              {
                name: 'de_mirage',
                label: 'Mirage',
                grenade_count: 1,
                has_lower_radar: false,
              },
            ];
          case 'get_map_overview':
          case 'get_throw_overview': {
            const available =
              !args.filters.favorites_only || Boolean(model.favorites[35]);
            return {
              map: {
                name: 'de_mirage',
                label: 'Mirage',
                grenade_count: 1,
                has_lower_radar: false,
              },
              grenade_count: available ? 1 : 0,
              clusters: available
                ? [
                    {
                      id: '1:2',
                      x: 50,
                      y: 60,
                      count: 1,
                      first_grenade_id: 101,
                      side_key: 'T',
                      unique_types: ['smoke'],
                      radar_level: 'default',
                    },
                  ]
                : [],
              type_counts: available ? { smoke: 1 } : {},
              side_counts: available ? { T: 1 } : {},
            };
          }
          case 'get_cluster_grenades':
          case 'get_throw_cluster_grenades':
            return [
              { ...detail(101), favorite_id: model.favorites[35] ? 35 : null },
            ];
          case 'get_onboarding_state':
            return { completed: true };
          case 'get_favorites_state':
            return {
              collections: model.collections.map((c) => ({
                ...c,
                grenade_count: Object.values(model.favorites).filter((g) =>
                  g.collection_ids.includes(c.id),
                ).length,
              })),
              maps: ['de_mirage'],
              favorites: Object.fromEntries(
                Object.values(model.favorites).map((g) => [
                  g.id,
                  [...g.collection_ids],
                ]),
              ),
              source_matches:
                model.active && model.favorites[35] ? { 101: 35 } : {},
            };
          case 'list_favorites': {
            const f = args.filters;
            const all = Object.values(model.favorites)
              .filter(
                (g) =>
                  (!f.collection_id ||
                    g.collection_ids.includes(f.collection_id)) &&
                  (!f.map || g.map === f.map) &&
                  (!f.side || f.side === 'Any' || f.side === g.side) &&
                  (!f.grenade_type ||
                    f.grenade_type === 'all' ||
                    f.grenade_type === g.grenade_type) &&
                  (!f.search ||
                    `${g.thrower} ${g.coordinates}`
                      .toLowerCase()
                      .includes(f.search.toLowerCase())),
              )
              .sort((a, b) => b.id - a.id);
            return {
              items: all.slice(
                f.offset ?? 0,
                (f.offset ?? 0) + (f.limit ?? 30),
              ),
              total: all.length,
            };
          }
          case 'get_favorite':
            if (!model.favorites[args.id]) throw new Error('Missing favorite');
            return model.favorites[args.id];
          case 'delete_favorite':
            delete model.favorites[args.id];
            return null;
          case 'create_favorite_collection': {
            const id = model.nextCollection++;
            model.collections.push({
              id,
              name: args.name.trim(),
              grenade_count: 0,
            });
            return id;
          }
          case 'rename_favorite_collection':
            model.collections.find((c) => c.id === args.id).name =
              args.name.trim();
            return null;
          case 'delete_favorite_collection':
            model.collections = model.collections.filter(
              (c) => c.id !== args.id,
            );
            Object.values(model.favorites).forEach((g) => {
              g.collection_ids = g.collection_ids.filter(
                (id) => id !== args.id,
              );
            });
            return null;
          case 'set_favorite_collections':
            model.favorites[args.id].collection_ids = args.collectionIds;
            return null;
          default:
            throw new Error(`Unhandled fixture command ${command}`);
        }
      },
    };
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:1427/favorites');
  await page.getByRole('button', { name: 'Следующие избранные' }).waitFor();
  await page.locator('.boot-screen').waitFor({ state: 'hidden' });
  await page.locator('.nade-row').first().waitFor();
  assert.equal(await page.locator('.nade-row').count(), 30);
  await page.screenshot({ path: 'dist/favorites-ui-wide.png', fullPage: true });
  await page.getByRole('button', { name: 'Следующие избранные' }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 6 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  await page.getByRole('button', { name: 'Предыдущие избранные' }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 30 &&
      !document.querySelector('.nade-list-skeleton'),
  );

  await page.getByRole('button', { name: 'Создать подборку' }).click();
  const name = page.getByRole('textbox', { name: 'Название', exact: true });
  await name.pressSequentially('Раскидки на A', { delay: 10 });
  assert.equal(await name.inputValue(), 'Раскидки на A');
  assert.equal(
    await name.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: 'Раскидки на A 0', exact: true })
    .waitFor();

  const row = page.locator('.nade-row').filter({ hasText: 'Player 36' });
  await row.getByRole('button', { name: 'Управлять подборками' }).click();
  await page.getByRole('checkbox', { name: 'Тренировка Mirage' }).check();
  await page.getByRole('checkbox', { name: 'Раскидки на A' }).check();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: 'Раскидки на A 1', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 1 &&
      !document.querySelector('.nade-list-skeleton'),
  );

  // Deleting a collection must leave saved snapshots intact.
  await page
    .getByRole('button', { name: 'Удалить подборку', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Удалить подборку', exact: true })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(
      () => Object.keys(window.__favoritesFixture.favorites).length,
    ),
    36,
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.__favoritesFixture.favorites[36].collection_ids,
    ),
    [1],
  );

  await page
    .getByRole('searchbox', { name: 'Поиск в избранном' })
    .fill('Player 36');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 1 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  await page.locator('.nade-open-action').click();
  await page.waitForURL('**/favorites/36');
  await page.getByText('Сохранённая граната #36').waitFor();
  await page
    .getByRole('button', { name: 'Копировать координаты гранаты' })
    .click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    'setpos 1 2 3; setang 10 20 0',
  );

  // Failed mutations retain the visible star and snapshot.
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'delete_favorite';
  });
  await page
    .getByRole('button', { name: 'Удалить из избранного и всех подборок' })
    .click();
  await page
    .getByText('Не удалось изменить избранное', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'Удалить из избранного и всех подборок' })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page
    .getByRole('button', { name: 'Удалить из избранного и всех подборок' })
    .click();
  await page.waitForURL('**/favorites');
  assert.equal(
    await page.evaluate(() => window.__favoritesFixture.favorites[36]),
    undefined,
  );

  // Narrow Russian layout and keyboard escape/focus restoration.
  await page.setViewportSize({ width: 760, height: 560 });
  await page.getByRole('button', { name: 'Создать подборку' }).click();
  await page.getByRole('textbox', { name: 'Название', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .getByRole('button', { name: 'Создать подборку' })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(
    await page
      .locator('.favorites-content')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  assert.equal(
    await page
      .locator('.viewer-topbar')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  await page.screenshot({
    path: 'dist/favorites-ui-narrow.png',
    fullPage: true,
  });
  // Original library records pass favorite filters to map, cluster and trajectory requests.
  await page.evaluate(() => {
    window.__favoritesFixture.active = {
      id: 1,
      kind: 'grenade_index',
      source_path: 'Test library',
      imported_at: '2026-10-13',
      grenade_count: 1,
      map_count: 1,
      is_active: true,
    };
  });
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.getByRole('button', { name: 'Maps', exact: true }).click();
  await page.locator('.map-tile').first().click();
  await page.waitForURL('**/map/de_mirage');
  await page
    .getByRole('button', { name: 'Favorites only', exact: true })
    .click();
  await page.locator('.cluster-list button').first().click();
  await page.locator('.nade-row').first().waitFor();
  const requests = await page.evaluate(() =>
    window.__favoritesFixture.calls.filter(
      (call) =>
        ['get_map_overview', 'get_cluster_grenades'].includes(call.command) &&
        call.args.filters.favorites_only,
    ),
  );
  assert.ok(requests.some((call) => call.command === 'get_map_overview'));
  assert.ok(
    requests.some(
      (call) =>
        call.command === 'get_cluster_grenades' && call.args.limit === 30,
    ),
  );
  assert.ok(
    requests.some(
      (call) =>
        call.command === 'get_cluster_grenades' && call.args.limit === 0,
    ),
  );
  await page
    .locator('.nade-row')
    .getByRole('button', { name: 'Remove from favorites and all collections' })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.cluster-list button') &&
      window.__favoritesFixture.calls.some(
        (call) =>
          call.command === 'get_map_overview' &&
          call.args.filters.favorites_only &&
          !window.__favoritesFixture.favorites[35],
      ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'Favorites UI checks passed: pagination, collections, immutable navigation without an active library, copy, errors, narrow Russian layout, keyboard focus.',
  );
} catch (error) {
  await page
    ?.screenshot({ path: 'dist/favorites-ui-failure.png', fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
