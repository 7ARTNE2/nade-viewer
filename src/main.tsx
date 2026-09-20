// No static imports: let the HTML splash paint while Vite loads the app graph.
performance.mark('startup:entry');
console.info(`[startup] Entry loaded: ${Math.round(performance.now())} ms`);

void import('./bootstrap').catch((error: unknown) => {
  console.error('[startup] Unable to load application modules', error);
  const status = document.getElementById('startup-initial-status');
  if (status) status.textContent = 'Unable to start / Не удалось запустить';
  const retry = document.getElementById('startup-initial-retry');
  if (retry) {
    retry.hidden = false;
    retry.addEventListener('click', () => window.location.reload());
  }
});
