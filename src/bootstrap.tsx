import React, { useLayoutEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import { I18nProvider } from './i18n';
import { ToastProvider } from './components/Toast';
import './styles.css';
import './uiEnhancements.css';

performance.mark('startup:react-modules-ready');
console.info(
  `[startup] React modules ready: ${Math.round(performance.now())} ms`,
);

function StartupHandoff() {
  useLayoutEffect(() => {
    // Uncover either the React boot screen or the error boundary after commit.
    document.getElementById('startup-initial')?.remove();
    performance.mark('startup:react-screen');
    console.info(
      `[startup] React screen mounted: ${Math.round(performance.now())} ms`,
    );
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StartupHandoff />
    <BrowserRouter>
      <I18nProvider>
        <ToastProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </ToastProvider>
      </I18nProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
