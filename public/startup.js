/* global window, console, performance, requestAnimationFrame, PerformanceObserver */
// A classic deferred script, independent of Vite's React module graph.
function report(phase, extra = {}) {
  const navigation = performance.getEntriesByType('navigation')[0];
  const timing = {
    timeOrigin: new Date(performance.timeOrigin).toISOString(),
    now: Math.round(performance.now()),
    ...Object.fromEntries(
      [
        'fetchStart',
        'domainLookupStart',
        'domainLookupEnd',
        'connectStart',
        'connectEnd',
        'requestStart',
        'responseStart',
        'responseEnd',
        'domInteractive',
        'domContentLoadedEventEnd',
        'loadEventEnd',
      ].map((key) => [key, Math.round(navigation?.[key] ?? 0)]),
    ),
    ...extra,
  };
  console.info(`[startup] ${phase}`, timing);
  window.__TAURI_INTERNALS__
    ?.invoke('report_startup_timing', {
      phase,
      timing: JSON.stringify(timing),
    })
    .catch((error) => console.error('[startup] Timing report failed', error));
}

report('HTML parsed');
requestAnimationFrame(() => {
  report('HTML frame');
});
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    report(entry.name, { paintTime: Math.round(entry.startTime) });
  }
}).observe({ type: 'paint', buffered: true });
