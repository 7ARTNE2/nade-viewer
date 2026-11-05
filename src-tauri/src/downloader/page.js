/* global __EXPECTED__, __REQUEST__, window, document, location, URL */
(() => {
  const expected = __EXPECTED__;
  if (
    window.top !== window ||
    location.href !== expected ||
    document.readyState === 'loading'
  )
    return;
  const date = (node) => {
    if (!node) return null;
    const d = new Date(Number(node.dataset.unix));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const text = (node, selector) =>
    node.querySelector(selector)?.textContent.trim() || '';
  const money = (value) =>
    /^\$[\d,]+$/.test(value.trim())
      ? Number(value.replace(/[^\d]/g, ''))
      : null;
  const event = (node) => {
    const cells = [...node.querySelectorAll('tr:first-child td')];
    const dates = [...node.querySelectorAll('[data-unix]')];
    const ongoing = node.classList.contains('ongoing-event');
    const shares = [...node.querySelectorAll('.moneyShare-row')];
    return {
      id: Number(new URL(node.href).pathname.split('/')[2]),
      url: node.href,
      name:
        text(node, '.event-col') ||
        text(node, '.event-name-small .text-ellipsis'),
      start_date: date(dates[0]),
      end_date: date(dates.at(-1)),
      prize: ongoing ? null : money(cells[2]?.textContent || ''),
      player_share: money(
        shares
          .find((s) => s.textContent.includes('Player Share'))
          ?.querySelector('.moneyShare-row-right')?.textContent || '',
      ),
      club_share: money(
        shares
          .find((s) => s.textContent.includes('Club Share'))
          ?.querySelector('.moneyShare-row-right')?.textContent || '',
      ),
      teams: ongoing ? '' : cells[1]?.textContent.trim() || '',
      kind: ongoing
        ? text(node, '.lan-marker')
        : cells[3]?.textContent.trim() || '',
      location: text(node, '.smallCountry').replace(/\s*\|\s*$/, ''),
      status: ongoing ? 'ongoing' : 'finished',
    };
  };
  const main = document.querySelector('.contentCol') || document.body;
  const challenge =
    /just a moment|attention required|access denied/i.test(document.title) ||
    /verify you are human|checking your browser/i.test(
      main.innerText.slice(0, 700),
    );
  let result = { url: location.href, title: document.title, challenge };
  if (location.pathname.startsWith('/events/archive')) {
    result.events = [...document.querySelectorAll('a.small-event')].map(event);
    result.next =
      document
        .querySelector('a.pagination-next:not(.disabled)')
        ?.getAttribute('href') || null;
    result.valid =
      !!document.querySelector('.pagination-data') ||
      result.events.length > 0 ||
      /0 - 0 of 0/.test(main.innerText);
  } else if (location.pathname === '/events') {
    result.events = [
      ...new Map(
        [...document.querySelectorAll('a.ongoing-event')].map((e) => [
          e.href,
          event(e),
        ]),
      ).values(),
    ];
    result.valid = /Ongoing events/i.test(main.innerText);
  } else if (location.pathname === '/results') {
    result.matches = [
      ...new Set(
        [...main.querySelectorAll('a[href*="/matches/"]')].map((e) => e.href),
      ),
    ];
    result.next =
      document
        .querySelector('a.pagination-next:not(.disabled)')
        ?.getAttribute('href') || null;
    result.valid =
      !!document.querySelector('.results-holder') ||
      !!document.querySelector('.results-all');
  } else if (location.pathname.startsWith('/matches/')) {
    const eventLink =
      document.querySelector('.match-info-box a[href^="/events/"]') ||
      document.querySelector('a[href^="/events/"]:not(.dropdown-link)');
    result.tournament = eventLink?.textContent.trim() || '';
    result.date = date(document.querySelector('.date[data-unix]'));
    result.demo =
      document
        .querySelector('[data-demo-link]')
        ?.getAttribute('data-demo-link') || null;
    result.valid = !!result.date && !!result.tournament;
  }
  // A blocked navigation is a one-way DOM report. The remote window has no
  // Tauri capabilities and never receives access to the application's IPC.
  location.href =
    'https://nadeviewer.invalid/report?payload=' +
    encodeURIComponent(JSON.stringify({ request: __REQUEST__, ...result }));
})();
