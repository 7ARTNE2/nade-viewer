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
      thrower_steamid64: String(id),
      thrower_team: id === 36 ? 'Blue' : 'Red',
      tournament: id === 36 ? 'Cup A' : 'Cup B',
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
      collections: [
        {
          id: 1,
          name: 'Тренировка Mirage',
          map: 'de_mirage',
          grenade_count: 0,
        },
      ],
      calls: [],
      failNext: null,
      nextCollection: 2,
      active: null,
    };
    const seed = window.sessionStorage.getItem('favorites-test-seed');
    if (seed) {
      Object.assign(model, JSON.parse(seed));
      window.sessionStorage.removeItem('favorites-test-seed');
    }
    const filtered = (f) =>
      Object.values(model.favorites)
        .filter(
          (g) =>
            (!f.collection_id || g.collection_ids.includes(f.collection_id)) &&
            (!f.map || g.map === f.map) &&
            (!f.side || f.side === 'Any' || f.side === g.side) &&
            (!f.grenade_type ||
              f.grenade_type === 'all' ||
              f.grenade_type === g.grenade_type) &&
            (!f.search ||
              `${g.thrower} ${g.coordinates}`
                .toLowerCase()
                .includes(f.search.toLowerCase())) &&
            (!f.jump || f.jump !== 'grounded') &&
            (!f.movement || f.movement !== 'moving') &&
            !f.is_insta &&
            (!f.min_usage || g.usage_count >= f.min_usage) &&
            (!f.thrower_team?.length ||
              f.thrower_team.includes(g.thrower_team)) &&
            (!f.thrower_steamid64?.length ||
              f.thrower_steamid64.includes(g.thrower_steamid64)) &&
            (!f.tournament?.length || f.tournament.includes(g.tournament)),
        )
        .sort((a, b) => b.id - a.id);
    const mapSummary = {
      name: 'de_mirage',
      label: 'Mirage',
      grenade_count: 36,
      has_lower_radar: false,
      map_image_path:
        '/@fs/F:/Dev/NadeViewer/src-tauri/resources/maps/2d/de_mirage_radar_psd.png',
    };
    window.__favoritesFixture = model;
    let callback = 0;
    const callbacks = new Map();
    const listeners = new Map();
    window.__favoritesDrop = (path) => {
      for (const [id, listener] of listeners) {
        if (listener.event === 'tauri://drag-drop') {
          callbacks.get(listener.handler)?.({
            event: listener.event,
            id,
            payload: { paths: [path], position: { x: 0, y: 0 } },
          });
        }
      }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => listeners.delete(id),
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: (handler) => {
        callbacks.set(++callback, handler);
        return callback;
      },
      unregisterCallback: (id) => callbacks.delete(id),
      convertFileSrc: (path) => path,
      async invoke(command, args) {
        model.calls.push({ command, args });
        if (model.failNext === command) {
          model.failNext = null;
          throw new Error('Test failure');
        }
        if (command === 'plugin:event|listen') {
          listeners.set(args.handler, args);
          return args.handler;
        }
        if (command === 'plugin:event|unlisten') {
          listeners.delete(args.eventId);
          return null;
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
          case 'export_favorites_share':
            return model.cancelShare ? null : 'mirage-2026-10-15.nvshare';
          case 'select_import_file':
            return model.importPath ?? 'received.nvshare';
          case 'get_import_status':
            return {
              running: false,
              stage: 'done',
              current: 1,
              total: 1,
              message: 'Favorites import complete',
              phase_current: 1,
              phase_total: 1,
            };
          case 'import_json': {
            const id = 200;
            const reused = Boolean(model.favorites[id]);
            model.favorites[id] = { ...detail(id), collection_ids: [30] };
            if (!reused)
              model.collections.push({
                id: 30,
                name: 'Полученная подборка',
                map: 'de_mirage',
                grenade_count: 1,
              });
            return {
              kind: 'favorites_share',
              grenade_count: 1,
              map_count: 1,
              added_count: reused ? 0 : 1,
              reused_count: reused ? 1 : 0,
              collection_count: 1,
              added_collections: reused ? 0 : 1,
              merged_collections: reused ? 1 : 0,
              source_path: args.path,
            };
          }
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
          case 'get_favorite_filter_options': {
            const all = filtered({
              map: args.filters.map,
              collection_id: args.filters.collection_id,
            });
            return {
              players: all
                .filter(
                  (g) =>
                    !args.filters.tournament?.length ||
                    args.filters.tournament.includes(g.tournament),
                )
                .map((g) => ({
                  steamid64: g.thrower_steamid64,
                  name: g.thrower,
                  team_name: g.thrower_team,
                  side: g.side,
                })),
              tournaments: [...new Set(all.map((g) => g.tournament))].map(
                (name) => ({
                  name,
                  start_date: '2026-10-01',
                  end_date: '2026-10-01',
                }),
              ),
            };
          }
          case 'get_favorite_maps':
            return [
              'de_ancient',
              'de_anubis',
              'de_cache',
              'de_dust2',
              'de_inferno',
              'de_mirage',
              'de_nuke',
              'de_overpass',
              'de_train',
              'de_vertigo',
            ].map((map) => ({
              ...mapSummary,
              name: map,
              preview_image_path: `/@fs/F:/Dev/NadeViewer/src-tauri/resources/maps/preview/map_icon_${map}.svg`,
              label:
                map === 'de_mirage'
                  ? 'Mirage'
                  : map === 'de_nuke'
                    ? 'Nuke'
                    : map === 'de_dust2'
                      ? 'Dust II'
                      : map
                          .slice(3)
                          .replace(/^./, (letter) => letter.toUpperCase()),
              grenade_count: filtered({ map }).length,
            }));
          case 'get_favorite_map_overview': {
            const all = filtered(args.filters);
            if (model.delayNextOverview) {
              model.delayNextOverview = false;
              await new Promise((resolve) => {
                model.releaseOverview = resolve;
              });
            }
            return {
              map: {
                ...mapSummary,
                name: args.map,
                label:
                  args.map === 'de_mirage'
                    ? 'Mirage'
                    : args.map === 'de_nuke'
                      ? 'Nuke'
                      : 'Dust II',
              },
              grenade_count: all.length,
              clusters: all.length
                ? [
                    {
                      id: args.mode === 'throw' ? '2:3' : '1:2',
                      x: 50,
                      y: 60,
                      count: all.length,
                      first_grenade_id: all[0].id,
                      side_key: 'T',
                      unique_types: ['smoke'],
                      radar_level: 'default',
                    },
                  ]
                : [],
              type_counts: { smoke: all.length },
              side_counts: { T: all.length },
            };
          }
          case 'get_favorite_cluster_grenades':
          case 'list_favorites': {
            const f = args.filters;
            const all = filtered(f);
            const items =
              f.limit === 0
                ? all
                : all.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 30));
            return command === 'list_favorites'
              ? { items, total: all.length }
              : items;
          }
          case 'get_favorite':
            if (!model.favorites[args.id]) throw new Error('Missing favorite');
            return model.favorites[args.id];
          case 'delete_favorite':
            delete model.favorites[args.id];
            return null;
          case 'clear_favorites':
            model.favorites = {};
            return null;
          case 'create_favorite_collection': {
            const id = model.nextCollection++;
            model.collections.push({
              id,
              name: args.name.trim(),
              map: args.map,
              grenade_count: 0,
            });
            return id;
          }
          case 'rename_favorite_collection':
            model.collections.find((c) => c.id === args.id).name =
              args.name.trim();
            return null;
          case 'assign_favorite_collection_map':
            model.collections.find((c) => c.id === args.id).map = args.map;
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
  await page
    .getByRole('button', { name: 'Следующие выбранные гранаты' })
    .waitFor();
  await page.locator('.boot-screen').waitFor({ state: 'hidden' });
  await page.locator('.nade-row').first().waitFor();
  assert.equal(await page.locator('.nade-row').count(), 30);
  const mapTab = (name) =>
    page.locator('.favorites-map-tab').filter({ hasText: name });
  const allMapsToggle = () =>
    page.getByRole('button', { name: /^(Все карты|All maps)$/ });
  const chooseMap = async (name) => {
    if (!(await mapTab(name).count())) await allMapsToggle().click();
    await mapTab(name).click();
    if ((await allMapsToggle().getAttribute('aria-expanded')) === 'true')
      await allMapsToggle().click();
  };
  const collectionSelector = () =>
    page.locator('.favorites-collection-select [role="combobox"]');
  const chooseCollection = async (value) => {
    await collectionSelector().click();
    const options = page.locator(
      '.favorites-collection-select-menu [role="option"]',
    );
    if (typeof value === 'object') {
      await options.filter({ hasText: value.label }).click();
    } else {
      const index = await page.evaluate((id) => {
        const map = JSON.parse(
          window.sessionStorage.getItem('nadeviewer.favorites-selection'),
        ).map;
        return id
          ? window.__favoritesFixture.collections
              .filter((c) => c.map === map)
              .findIndex((c) => String(c.id) === id) + 1
          : 0;
      }, value);
      await options.nth(index).click();
    }
    await page
      .locator('.favorites-collection-select-menu')
      .waitFor({ state: 'hidden' });
  };
  assert.equal(await mapTab('Mirage').locator('b').textContent(), '36');
  assert.equal(await mapTab('Nuke').count(), 0);
  assert.equal(await allMapsToggle().getAttribute('aria-expanded'), 'false');
  await allMapsToggle().click();
  assert.equal(await allMapsToggle().getAttribute('aria-expanded'), 'true');
  assert.equal(
    await page
      .locator('.favorites-map-tab')
      .first()
      .locator('span')
      .textContent(),
    'Mirage',
  );
  assert.equal(await mapTab('Nuke').locator('b').textContent(), '0');
  await allMapsToggle().click();
  assert.equal(await mapTab('Nuke').count(), 0);
  const pointIcons = page.locator('.map-appearance-toggle');
  assert.equal(await pointIcons.getAttribute('aria-pressed'), 'true');
  await page.locator('.map-canvas.icon-theme-asset').waitFor();
  await pointIcons.click();
  assert.equal(await pointIcons.getAttribute('aria-pressed'), 'false');
  const exportTrigger = () =>
    page.getByRole('button', {
      name: /^(Экспорт избранного|Export favorites)$/,
    });
  const exportMenu = () => page.locator('.favorites-export-menu');
  const exportScope = async (name) => {
    await exportTrigger().click();
    await exportMenu().getByRole('menuitem', { name }).click();
    await exportMenu().waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => !document.querySelector('.favorites-export-trigger')?.disabled,
    );
  };
  assert.equal(await page.locator('.favorites-share-actions').count(), 0);
  await exportTrigger().press('ArrowDown');
  await exportMenu().getByRole('menuitem').first().waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('favorites-export-trigger'),
  );
  assert.equal(
    await exportTrigger().evaluate((el) => el === document.activeElement),
    true,
  );
  await exportScope(/Все избранные карты/);
  await exportScope(/Все карты/);
  const shareCalls = await page.evaluate(() =>
    window.__favoritesFixture.calls
      .filter((call) => call.command === 'export_favorites_share')
      .map((call) => call.args.scope),
  );
  assert.deepEqual(shareCalls, [
    { kind: 'map', map: 'de_mirage' },
    { kind: 'all' },
  ]);
  await chooseMap('Nuke');
  assert.equal(await mapTab('Nuke').getAttribute('aria-pressed'), 'true');
  assert.equal(await mapTab('Ancient').count(), 0);
  assert.equal(await pointIcons.getAttribute('aria-pressed'), 'true');
  await exportTrigger().click();
  assert.equal(
    await exportMenu()
      .getByRole('menuitem', { name: /Все избранные карты/ })
      .isDisabled(),
    true,
  );
  await page.keyboard.press('Escape');
  await mapTab('Mirage').click();
  await page.locator('.nade-row').first().waitFor();
  assert.equal(await pointIcons.getAttribute('aria-pressed'), 'false');
  await pointIcons.click();
  await page.evaluate(() => {
    window.__favoritesFixture.cancelShare = true;
  });
  await exportScope(/Все карты/);
  await page.waitForFunction(
    () =>
      window.__favoritesFixture.calls.filter(
        (call) => call.command === 'export_favorites_share',
      ).length === 3,
  );
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.favorites-export-trigger')].some(
        (button) => button.disabled,
      ),
  );
  await page.evaluate(() => {
    window.__favoritesFixture.cancelShare = false;
    window.__favoritesFixture.failNext = 'export_favorites_share';
  });
  await exportTrigger().click();
  await exportMenu()
    .getByRole('menuitem', { name: /Все карты/ })
    .click();
  await page.waitForFunction(
    () =>
      window.__favoritesFixture.calls.filter(
        (call) => call.command === 'export_favorites_share',
      ).length === 4,
  );
  await page
    .locator('.favorites-share-error')
    .filter({ hasText: 'Не удалось экспортировать избранное' })
    .waitFor();
  await page.keyboard.press('Escape');
  assert.equal(
    await page.getByRole('button', { name: 'Выбрать карту' }).count(),
    0,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('.favorites-map-tab img')
    .first()
    .evaluate((img) => img.decode());
  assert.equal(
    await page
      .locator('.favorites-map-tab img')
      .evaluateAll((imgs) =>
        imgs.every((img) => img.complete && img.naturalWidth > 0),
      ),
    true,
  );
  await page.screenshot({ path: 'dist/favorites-ui-wide.png', fullPage: true });
  await exportTrigger().click();
  await exportMenu()
    .getByRole('menuitem', { name: /Подборка/ })
    .click();
  await page.screenshot({
    path: 'dist/favorites-export-collections.png',
    fullPage: true,
  });
  await exportMenu()
    .getByRole('menuitem', { name: /Тренировка Mirage/ })
    .click();
  await exportMenu().waitFor({ state: 'hidden' });
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.__favoritesFixture.calls
          .filter((call) => call.command === 'export_favorites_share')
          .at(-1).args.scope,
    ),
    { kind: 'collection', collection_id: 1 },
  );
  // Exporting an empty collection works without selecting it in the workspace.
  await page.setViewportSize({ width: 390, height: 844 });
  await exportTrigger().click();
  await exportMenu().evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({
    path: 'dist/favorites-export-mobile.png',
    fullPage: true,
  });
  const menuBounds = await exportMenu().boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390);
  await page.keyboard.press('Escape');
  await exportTrigger().click();
  await page.locator('.favorites-map-tab').first().click();
  assert.equal(await exportMenu().count(), 0);
  await mapTab('Mirage').click();
  await page.setViewportSize({ width: 900, height: 650 });
  await page
    .getByRole('button', { name: 'Следующие выбранные гранаты' })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 6 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  await page
    .getByRole('button', { name: 'Предыдущие выбранные гранаты' })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 30 &&
      !document.querySelector('.nade-list-skeleton'),
  );

  // All match filters use saved records while no import is active.
  const chooseFilter = async (accent, option) => {
    const trigger = page.locator(`.accent-${accent} .tactical-filter-trigger`);
    await trigger.press('ArrowDown');
    const search = page.getByRole('dialog').getByRole('combobox');
    await search.fill(option);
    await page
      .getByRole('dialog')
      .getByRole('option')
      .filter({ hasText: option })
      .press('Enter');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(
      (accent) =>
        document.activeElement ===
        document.querySelector(`.accent-${accent} .tactical-filter-trigger`),
      accent,
    );
  };
  await chooseFilter('tournament', 'Cup A');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 1 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  await chooseFilter('team', 'Blue');
  await chooseFilter('player', 'Player 36');
  await page.waitForFunction(() =>
    window.__favoritesFixture.calls.some(
      (c) =>
        c.command === 'list_favorites' &&
        c.args.filters.thrower_steamid64?.includes('36'),
    ),
  );
  await page.locator('.inspector-visibility .section-toggle').click();
  await page.locator('.inspector-visibility input[type="range"]').fill('5');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page
    .getByText(
      'В этой подборке или с такими фильтрами нет сохранённых раскидок.',
    )
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.__favoritesFixture.calls.some(
        (c) => c.command === 'update_site_settings',
      ),
    ),
    false,
  );
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: 'dist/new-collection-wide.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 640 });
  assert.equal(
    await page.getByRole('dialog').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return (
        node.scrollWidth <= node.clientWidth + 1 &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    }),
    true,
  );
  await page.screenshot({
    path: 'dist/new-collection-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 650 });
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'create_favorite_collection';
  });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(await name.inputValue(), 'Раскидки на A');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await collectionSelector().click();
  await page.getByRole('option', { name: /Раскидки на A/ }).waitFor();
  await page.keyboard.press('Escape');

  // The same name on another map stays local to that map.
  await chooseMap('Nuke');
  await page
    .locator('.map-selector-current strong')
    .filter({ hasText: 'Nuke' })
    .waitFor();
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Подборка', exact: true })
      .getAttribute('data-value'),
    '',
  );
  await collectionSelector().click();
  assert.equal(
    await page
      .locator('.favorites-collection-select-menu [role="option"]')
      .count(),
    1,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Создать подборку' }).click();
  await page
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill('Раскидки на A');
  await page.getByRole('dialog').getByText('Nuke', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await chooseCollection('3');
  await mapTab('Mirage').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 30 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Подборка', exact: true })
      .getAttribute('data-value'),
    '',
  );

  const row = page.locator('.nade-row').filter({ hasText: 'Player 36' });
  await row.getByRole('button', { name: 'Управлять подборками' }).click();
  const picker = page.getByRole('dialog');
  const collectionSearch = picker.getByRole('searchbox', {
    name: 'Поиск подборок',
  });
  assert.equal(
    await collectionSearch.evaluate((node) => node === document.activeElement),
    true,
  );
  await collectionSearch.fill('несуществующая');
  await picker.getByText('Подборки не найдены', { exact: true }).waitFor();
  await picker.getByRole('button', { name: 'Очистить поиск' }).click();
  await collectionSearch.fill('на a');
  assert.equal(await picker.getByRole('checkbox').count(), 1);
  await picker.getByRole('button', { name: 'Очистить поиск' }).click();
  await picker
    .getByRole('textbox', { name: 'Название новой подборки' })
    .fill('Ошибка создания');
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'create_favorite_collection';
  });
  await picker.getByRole('button', { name: 'Создать', exact: true }).click();
  await picker
    .getByRole('alert')
    .filter({ hasText: 'Не удалось создать подборку' })
    .waitFor();
  await picker
    .getByRole('textbox', { name: 'Название новой подборки' })
    .fill('');
  assert.equal(
    await page.getByRole('checkbox', { name: 'Раскидки на A' }).count(),
    1,
  );
  await page.getByRole('checkbox', { name: 'Тренировка Mirage' }).check();
  await page.getByRole('checkbox', { name: 'Раскидки на A' }).check();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: 'dist/collection-picker-wide.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 640 });
  assert.equal(
    await picker.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return (
        node.scrollWidth <= node.clientWidth + 1 &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    }),
    true,
  );
  await page.screenshot({
    path: 'dist/collection-picker-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 650 });
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'set_favorite_collections';
  });
  await picker.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await picker
    .getByRole('alert')
    .filter({ hasText: 'Не удалось сохранить подборки' })
    .waitFor();
  assert.equal(
    await picker.getByRole('checkbox', { checked: true }).count(),
    2,
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await chooseCollection({ label: 'Раскидки на A' });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 1 &&
      !document.querySelector('.nade-list-skeleton'),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await collectionSelector().click();
  const selectorMenu = page.locator('.favorites-collection-select-menu');
  await selectorMenu
    .getByRole('combobox', { name: 'Поиск подборок' })
    .fill('на A');
  assert.equal(await selectorMenu.getByRole('option').count(), 2);
  await selectorMenu.getByRole('combobox').fill('');
  await page.screenshot({
    path: 'dist/collection-controls-wide.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () =>
      document.activeElement ===
      document.querySelector('.favorites-collection-select [role="combobox"]'),
  );
  await collectionSelector().press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await selectorMenu.waitFor({ state: 'hidden' });
  assert.equal(await collectionSelector().getAttribute('data-value'), '2');
  await page
    .getByRole('button', { name: 'Переименовать подборку', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill('Раскидки на A: тренировка выходов и командные заготовки Mirage');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 360, height: 640 });
  assert.equal(
    await page.locator('.favorites-map-controls').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return (
        node.scrollWidth <= node.clientWidth + 1 &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth
      );
    }),
    true,
  );
  await collectionSelector().click();
  assert.equal(
    await selectorMenu.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        node.scrollWidth <= node.clientWidth + 1
      );
    }),
    true,
  );
  await page.screenshot({
    path: 'dist/collection-controls-mobile.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 900, height: 650 });

  assert.equal(await mapTab('Mirage').locator('b').textContent(), '36');
  assert.equal(await mapTab('Nuke').count(), 0);

  assert.equal(
    await page
      .locator('.map-workspace')
      .getByRole('button', { name: 'Избранное', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.locator('.inspector-visibility .section-toggle').count(),
    1,
  );
  assert.equal(
    await page.locator('.accent-tournament .tactical-filter-trigger').count(),
    1,
  );
  await page.getByRole('button', { name: 'Бросок', exact: true }).click();
  await page.waitForFunction(() =>
    window.__favoritesFixture.calls.some(
      (c) =>
        c.command === 'get_favorite_map_overview' && c.args.mode === 'throw',
    ),
  );
  await page.locator('.cluster-list button').first().click();
  await page.waitForFunction(() =>
    window.__favoritesFixture.calls.some(
      (c) =>
        c.command === 'get_favorite_cluster_grenades' &&
        c.args.filters.limit === 0,
    ),
  );
  await page.locator('.nade-open-action').first().click();
  await page.waitForURL('**/favorites/36');
  await page.goBack();
  await page.locator('.nade-row').first().waitFor();
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Подборка', exact: true })
      .getAttribute('data-value'),
    '2',
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Бросок', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await page.locator('.cluster-list button.selected').count(), 1);
  await page.locator('.cluster-list button.selected').click();

  // Deleting a collection must leave saved snapshots intact.
  await exportTrigger().click();
  await exportMenu()
    .getByRole('menuitem', { name: /Подборка/ })
    .click();
  await exportMenu()
    .getByRole('menuitem')
    .filter({ hasText: 'Выбранная подборка' })
    .click();
  await exportMenu().waitFor({ state: 'hidden' });
  const sharedCollection = await page.evaluate(() => {
    const current = JSON.parse(
      window.sessionStorage.getItem('nadeviewer.favorites-selection'),
    );
    return {
      scope: window.__favoritesFixture.calls
        .filter((call) => call.command === 'export_favorites_share')
        .at(-1).args.scope,
      selected: current.collectionId,
    };
  });
  assert.deepEqual(sharedCollection.scope, {
    kind: 'collection',
    collection_id: sharedCollection.selected,
  });
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

  await page.getByRole('textbox', { name: 'Найти гранату' }).fill('Player 36');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 1 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  // Use a full-length path so its middle is reachable separately from the throw marker.
  await page.evaluate(() => {
    window.__favoritesFixture.favorites[36].trajectory_preview = [
      [20, 30],
      [500, 600],
    ];
  });
  await page.locator('.nade-open-action').click();
  await page.waitForURL('**/favorites/36');
  await page.getByText('Сохранённая граната #36').waitFor();
  const detailTrajectory = page.locator(
    '.grenade-detail .trajectory-interactive',
  );
  assert.equal(await detailTrajectory.getAttribute('role'), 'button');
  const trajectoryHit = detailTrajectory.locator('.trajectory-hit-area');
  await trajectoryHit.hover();
  await page.locator('.throw-preview-popover').waitFor();
  await trajectoryHit.click({ button: 'right' });
  await page.waitForFunction(() =>
    document.querySelector('.grenade-detail .trajectory-copied'),
  );
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    'setpos 1 2 3; setang 10 20 0',
  );
  await trajectoryHit.click();
  assert.equal(
    await page
      .locator('.detail-inspector')
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await detailTrajectory.focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await page
      .locator('.detail-inspector')
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.ok(page.url().endsWith('/favorites/36'));
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
      .locator('.favorites-map-page')
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
  assert.equal(
    await page.evaluate(() =>
      window.__favoritesFixture.calls.some((c) =>
        [
          'get_maps',
          'get_map_overview',
          'get_import_players',
          'get_import_tournaments',
        ].includes(c.command),
      ),
    ),
    false,
  );
  // Empty collections keep their map; restoring All favorites keeps its own filters.
  await chooseCollection('1');
  await page
    .getByText(
      'В этой подборке или с такими фильтрами нет сохранённых раскидок.',
    )
    .waitFor();
  assert.equal(
    await page.locator('.map-selector-current strong').textContent(),
    'Mirage',
  );
  await chooseCollection('');
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 30 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  await page
    .getByRole('button', { name: 'Следующие выбранные гранаты' })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 5 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  for (let id = 5; id >= 1; id--) {
    await page
      .locator('.nade-row')
      .filter({ hasText: `Player ${id}` })
      .getByRole('button', { name: 'Удалить из избранного и всех подборок' })
      .click();
    await page.waitForFunction(
      (removed) =>
        !window.__favoritesFixture.favorites[removed] &&
        !document.querySelector('.nade-list-skeleton'),
      id,
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 30 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Следующие выбранные гранаты' })
      .count(),
    0,
  );

  // A response from a superseded collection cannot replace the latest view.
  await page.evaluate(() => {
    window.__favoritesFixture.delayNextOverview = true;
  });
  await chooseCollection('1');
  await page.waitForFunction(() =>
    Boolean(window.__favoritesFixture.releaseOverview),
  );
  await chooseCollection('');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.nade-row').length === 30 &&
      !document.querySelector('.nade-list-skeleton'),
  );
  await page.evaluate(() => {
    window.__favoritesFixture.releaseOverview();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('.map-selector-filtered-count b')?.textContent ===
      '30',
  );
  assert.equal(await page.locator('.nade-row').count(), 30);

  // Failure and retry use the saved-map command, without an import fallback.
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'get_favorite_map_overview';
  });
  await page.getByRole('button', { name: 'Бросок', exact: true }).click();
  await page.getByText('Не удалось открыть карту', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.locator('.cluster-list button').first().waitFor();

  // Empty Favorites still has map navigation and can create collections.
  await page.evaluate(() => {
    window.__favoritesFixture.backupFavorites =
      window.__favoritesFixture.favorites;
    window.__favoritesFixture.favorites = {};
    window.__favoritesFixture.collections.push({
      id: 20,
      name: 'Старая пустая',
      map: null,
      grenade_count: 0,
    });
    window.sessionStorage.setItem(
      'favorites-test-seed',
      JSON.stringify(window.__favoritesFixture),
    );
  });
  await page.reload();
  await page
    .getByRole('heading', { name: 'В избранном пока нет раскидок' })
    .waitFor();
  assert.equal(await page.locator('.map-workspace').count(), 0);
  assert.equal(await page.locator('.inspector').count(), 0);
  await page
    .locator('.favorites-empty-actions')
    .getByRole('button', { name: 'Импортировать файл' })
    .click();
  await page.waitForURL('**/import');
  await page.getByRole('button', { name: 'Избранное', exact: true }).click();
  await page.waitForURL('**/favorites');
  await page
    .getByRole('button', { name: 'Старая пустая', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Карта', exact: true })
    .selectOption('de_mirage');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await chooseCollection('20');
  assert.equal(await mapTab('Mirage').locator('b').textContent(), '0');
  await page.getByRole('button', { name: 'Создать подборку' }).click();
  await page
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill('Пустая');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await chooseCollection('4');
  await page.screenshot({
    path: 'dist/favorites-ui-empty-en.png',
    fullPage: true,
  });
  await allMapsToggle().focus();
  await page.keyboard.press('Enter');
  await mapTab('Nuke').focus();
  await page.keyboard.press('Enter');
  assert.equal(await mapTab('Nuke').getAttribute('aria-pressed'), 'true');
  await allMapsToggle().click();
  assert.equal(await mapTab('Nuke').getAttribute('aria-pressed'), 'true');
  assert.equal(await mapTab('Mirage').count(), 0);
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Collection', exact: true })
      .getAttribute('data-value'),
    '',
  );
  await page.getByRole('button', { name: 'RU', exact: true }).click();
  // Removing the final saved grenade preserves its empty collection and map.
  await page.evaluate(() => {
    window.__favoritesFixture.favorites = {
      35: {
        ...window.__favoritesFixture.backupFavorites[35],
        map: 'de_nuke',
        collection_ids: [3],
      },
    };
    window.sessionStorage.setItem(
      'favorites-test-seed',
      JSON.stringify(window.__favoritesFixture),
    );
  });
  await page.reload();
  await chooseCollection('3');
  await page.locator('.nade-row').first().waitFor();
  await page
    .locator('.nade-row')
    .getByRole('button', { name: 'Удалить из избранного и всех подборок' })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.favorites-map-tab.active b')?.textContent ===
      '0',
  );
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Подборка', exact: true })
      .getAttribute('data-value'),
    '3',
  );
  assert.equal(
    await page.locator('.map-selector-current strong').textContent(),
    'Nuke',
  );

  // Original library records pass favorite filters to map, cluster and trajectory requests.
  await page.evaluate(() => {
    window.__favoritesFixture.favorites =
      window.__favoritesFixture.backupFavorites;
    window.sessionStorage.setItem(
      'nadeviewer.map-view.1.de_mirage',
      JSON.stringify({
        filters: {
          grenade_type: 'smoke',
          side: 'T',
          favorites_only: true,
          favorite_collection_id: 999,
        },
      }),
    );
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
  const favoritesToggle = page
    .locator('.map-workspace')
    .getByRole('button', { name: 'Favorites', exact: true });
  assert.equal(await favoritesToggle.getAttribute('aria-pressed'), 'false');
  await favoritesToggle.click();
  assert.equal(await favoritesToggle.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Maps', exact: true }).click();
  await page.locator('.map-tile').first().click();
  await page.waitForURL('**/map/de_mirage');
  assert.equal(await favoritesToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(
          window.sessionStorage.getItem('nadeviewer.map-view.1.de_mirage'),
        ).filters.grenade_type,
    ),
    'smoke',
  );
  await page
    .locator('.map-workspace')
    .getByRole('button', { name: 'Favorites', exact: true })
    .click();
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Collection', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Collection', exact: true }).count(),
    0,
  );
  await page.locator('.cluster-list button').first().click();
  await page.locator('.nade-row').first().waitFor();
  const requests = await page.evaluate(() =>
    window.__favoritesFixture.calls.filter(
      (call) =>
        ['get_map_overview', 'get_cluster_grenades'].includes(call.command) &&
        call.args.filters.favorites_only,
    ),
  );
  assert.equal(
    requests.some((call) =>
      Object.hasOwn(call.args.filters, 'favorite_collection_id'),
    ),
    false,
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
  // Shared favorites use the common Import page and refresh saved map counts.
  const beforeImportCount = await page.evaluate(
    () =>
      Object.values(window.__favoritesFixture.favorites).filter(
        (favorite) => favorite.map === 'de_mirage',
      ).length,
  );
  await page
    .getByRole('button', { name: 'Import library', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Choose file', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Favorites imported', exact: true })
    .waitFor();
  await page
    .getByText(
      'Added: 1 favorites, 1 collections. Already saved: 0. Merged collections: 0.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        window.__favoritesFixture.calls.findLast(
          (call) => call.command === 'import_json',
        ).args.path,
    ),
    'received.nvshare',
  );
  // Both entry points accept the new extension and every legacy extension.
  for (const mode of ['picker', 'drop']) {
    for (const extension of [
      'nvshare',
      'nvshare.msgpack',
      'msgpack',
      'messagepack',
      'mpk',
      'NVSHARE',
    ]) {
      await page
        .getByRole('button', { name: 'Import another', exact: true })
        .click();
      const path = `received-${mode}.${extension}`;
      if (mode === 'picker') {
        await page.evaluate((path) => {
          window.__favoritesFixture.importPath = path;
        }, path);
        await page
          .getByRole('button', { name: 'Choose file', exact: true })
          .click();
      } else {
        await page.evaluate((path) => window.__favoritesDrop(path), path);
      }
      await page
        .getByRole('heading', { name: 'Favorites imported', exact: true })
        .waitFor();
      await page
        .getByText(
          'Added: 0 favorites, 0 collections. Already saved: 1. Merged collections: 1.',
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.__favoritesFixture.calls.findLast(
              (call) => call.command === 'import_json',
            ).args.path,
        ),
        path,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__favoritesFixture.collections.filter(
              (collection) => collection.id === 30,
            ).length,
        ),
        1,
      );
    }
  }
  await page
    .getByRole('button', { name: 'View favorites', exact: true })
    .click();
  await page.waitForURL('**/favorites');
  await mapTab('Mirage').click();
  await page.locator('.nade-row').first().waitFor();
  assert.equal(
    await mapTab('Mirage').locator('b').textContent(),
    String(beforeImportCount + 1),
  );
  assert.equal(
    await page.evaluate(() => window.__favoritesFixture.active.id),
    1,
  );
  // Clearing affects every map, requires confirmation, and preserves collections/library.
  await page.evaluate(() => {
    window.__favoritesFixture.favorites[100] = {
      ...Object.values(window.__favoritesFixture.favorites)[0],
      id: 100,
      favorite_id: 100,
      map: 'de_nuke',
      collection_ids: [3],
    };
    window.sessionStorage.setItem(
      'favorites-test-seed',
      JSON.stringify({
        favorites: window.__favoritesFixture.favorites,
        collections: window.__favoritesFixture.collections,
        active: window.__favoritesFixture.active,
      }),
    );
  });
  await page.reload();
  await page.locator('.boot-screen').waitFor({ state: 'hidden' });
  const beforeClear = await page.evaluate(() => ({
    total: Object.keys(window.__favoritesFixture.favorites).length,
    collections: window.__favoritesFixture.collections,
    active: window.__favoritesFixture.active,
  }));
  const openClearDialog = async () => {
    await page
      .getByRole('button', {
        name: /^(Library actions|Действия с библиотекой)$/,
      })
      .click();
    await page
      .getByRole('button', {
        name: /^(Clear all favorites|Очистить всё избранное)$/,
      })
      .click();
    await page
      .getByRole('dialog', {
        name: /Clear all favorites|Очистить всё избранное/,
      })
      .waitFor();
  };
  const clearDialog = () => page.getByRole('dialog');
  const confirmClear = () =>
    clearDialog().getByRole('button', {
      name: /^(Clear all favorites|Очистить всё избранное)$/,
    });
  await openClearDialog();
  assert.equal(
    await clearDialog().locator('.snapshot-delete-meta strong').textContent(),
    String(beforeClear.total),
  );
  await clearDialog()
    .getByRole('button', { name: /^(Cancel|Отмена)$/ })
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        window.__favoritesFixture.calls.filter(
          (call) => call.command === 'clear_favorites',
        ).length,
    ),
    0,
  );
  await openClearDialog();
  const exportBeforeClear = () =>
    clearDialog().getByRole('button', {
      name: /Export before clearing|Экспортировать перед очисткой/,
    });
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'export_favorites_share';
  });
  await exportBeforeClear().click();
  await clearDialog().getByRole('alert').waitFor();
  assert.equal(
    await page.evaluate(
      () => Object.keys(window.__favoritesFixture.favorites).length,
    ),
    beforeClear.total,
  );
  await exportBeforeClear().click();
  await confirmClear().waitFor({ state: 'visible' });
  await page.waitForFunction(
    () =>
      !document.querySelector('[role="dialog"]')?.getAttribute('aria-busy') ||
      document.querySelector('[role="dialog"]').getAttribute('aria-busy') ===
        'false',
  );
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.__favoritesFixture.calls
          .filter((call) => call.command === 'export_favorites_share')
          .at(-1).args.scope,
    ),
    { kind: 'all' },
  );
  await page.evaluate(() => {
    window.__favoritesFixture.failNext = 'clear_favorites';
  });
  await confirmClear().click();
  await clearDialog().getByRole('alert').waitFor();
  assert.equal(
    await page.evaluate(
      () => Object.keys(window.__favoritesFixture.favorites).length,
    ),
    beforeClear.total,
  );
  await page.setViewportSize({ width: 390, height: 780 });
  assert.equal(
    await clearDialog().evaluate(
      (node) =>
        node.getBoundingClientRect().right <= window.innerWidth &&
        node.scrollWidth <= node.clientWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: 'dist/favorites-clear-dialog-mobile.png',
    fullPage: true,
  });
  await confirmClear().click();
  await clearDialog().waitFor({ state: 'hidden' });
  await page
    .getByRole('heading', {
      name: /No saved lineups yet|В избранном пока нет раскидок/,
    })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.__favoritesFixture.collections),
    beforeClear.collections,
  );
  assert.deepEqual(
    await page.evaluate(() => window.__favoritesFixture.active),
    beforeClear.active,
  );
  assert.equal(
    await page.evaluate(
      () => Object.keys(window.__favoritesFixture.favorites).length,
    ),
    0,
  );
  await page
    .getByRole('button', { name: /^(Library actions|Действия с библиотекой)$/ })
    .click();
  assert.equal(
    await page
      .getByRole('button', {
        name: /^(Clear all favorites|Очистить всё избранное)$/,
      })
      .count(),
    0,
  );
  await page
    .getByRole('button', { name: /^(Library actions|Действия с библиотекой)$/ })
    .click();
  // Empty collections remain exportable even when no saved grenades remain.
  await page.waitForFunction(
    () => document.querySelector('.favorites-map-tab b')?.textContent === '0',
  );
  assert.equal(await page.locator('.favorites-share-actions').count(), 0);
  await exportTrigger().click();
  assert.equal(
    await exportMenu()
      .getByRole('menuitem', { name: /All maps|Все карты/ })
      .isEnabled(),
    true,
  );
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  const russianToggle = page.getByRole('button', { name: 'RU', exact: true });
  if (await russianToggle.count()) await russianToggle.click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole('heading', { name: 'В избранном пока нет раскидок' })
    .waitFor();
  await page.screenshot({
    path: 'dist/favorites-empty-ru.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 780 });
  assert.equal(
    await page
      .locator('.favorites-map-page')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  await page.screenshot({
    path: 'dist/favorites-empty-mobile-ru.png',
    fullPage: true,
  });
  await page
    .locator('.favorites-empty-actions')
    .getByRole('button', { name: 'Открыть карты' })
    .click();
  await page.waitForURL('**/maps');
  await page.getByRole('button', { name: 'Избранное', exact: true }).click();
  await page
    .locator('.favorites-empty-actions')
    .getByRole('button', { name: 'Импортировать избранное' })
    .click();
  await page.waitForURL('**/import');
  console.log(
    'Favorites UI checks passed: all sharing scopes, export cancellation/failure, new and legacy favorites imports via picker/drop, repeated import, saved maps without imports, collections, empty selections, stale responses, pagination after removal, state restoration, retries, legacy filters, copy and keyboard focus.',
  );
} catch (error) {
  console.error(
    await page?.evaluate(() => ({
      recentCalls: window.__favoritesFixture?.calls.slice(-10),
      shareCalls: window.__favoritesFixture?.calls.filter(
        (call) => call.command === 'export_favorites_share',
      ),
      failNext: window.__favoritesFixture?.failNext,
      toast: document.querySelector('.toast-viewport')?.textContent,
    })),
  );
  await page
    ?.screenshot({ path: 'dist/favorites-ui-failure.png', fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
