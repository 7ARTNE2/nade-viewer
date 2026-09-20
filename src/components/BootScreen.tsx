import { useEffect, useState } from 'react';
import { version } from '../../package.json';
import { useI18n } from '../i18n';
import './BootScreen.css';

type BootScreenProps = {
  ready: boolean;
  error: string | null;
  onComplete: () => void;
};

// A single trajectory reveal carries the existing tactical identity into startup.
// The indicator is indeterminate: only application initialization signals readiness.
export default function BootScreen({
  ready,
  error,
  onComplete,
}: BootScreenProps) {
  const { tr } = useI18n();
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Startup motion is intentionally independent of the Windows animation setting.
    const entrance = window.setTimeout(() => setEntered(true), 700);
    const slowStartup = window.setTimeout(() => setSlow(true), 8000);
    return () => {
      window.clearTimeout(entrance);
      window.clearTimeout(slowStartup);
    };
  }, []);

  useEffect(() => {
    if (!ready || !entered) return;
    setLeaving(true);
    const exit = window.setTimeout(onComplete, 280);
    return () => window.clearTimeout(exit);
  }, [ready, entered, onComplete]);

  return (
    <section
      className={`startup-screen${leaving ? ' is-leaving' : ''}`}
      aria-label={tr('Starting Nade Viewer', 'Запуск Nade Viewer')}
      aria-busy={!ready && !error}
    >
      <div className="startup-composition">
        <svg
          className="startup-trajectory"
          viewBox="0 0 440 180"
          fill="none"
          aria-hidden="true"
        >
          <g className="startup-guides">
            <path d="M32 132H408M80 124V140M220 124V140M360 124V140" />
            <path d="M24 40V24H40M400 24H416V40M24 148V164H40M400 164H416V148" />
            <circle cx="360" cy="132" r="24" />
            <path d="M328 132H344M376 132H392M360 100V116M360 148V164" />
          </g>
          <path
            className="startup-flight-base"
            d="M80 132C137 6 242 6 298 132Q317 92 338 132Q349 114 360 132"
          />
          <path
            className="startup-flight"
            pathLength="1"
            d="M80 132C137 6 242 6 298 132Q317 92 338 132Q349 114 360 132"
          />
          <circle className="startup-origin" cx="80" cy="132" r="4" />
          <circle className="startup-impact" cx="360" cy="132" r="6" />
          <circle className="startup-impact-ring" cx="360" cy="132" r="16" />
        </svg>

        <h1 className="startup-name">
          NADE <span>VIEWER</span>
        </h1>
        <p className="startup-description">
          {tr(
            'Your Counter-Strike 2 lineup workspace',
            'Ваши раскидки в Counter-Strike 2',
          )}
        </p>

        <div className="startup-loading">
          <div
            className={`startup-track${error ? ' has-error' : ''}`}
            aria-hidden="true"
          >
            <span />
          </div>
          <p className="startup-status" role="status" aria-live="polite">
            {error
              ? tr(
                  'Could not open the local library',
                  'Не удалось открыть локальную библиотеку',
                )
              : ready
                ? tr('Opening workspace', 'Открываем рабочее пространство')
                : slow
                  ? tr(
                      'Still loading your local library…',
                      'Продолжаем загрузку локальной библиотеки…',
                    )
                  : tr(
                      'Loading library and preferences',
                      'Загружаем библиотеку и настройки',
                    )}
          </p>
          {error ? (
            <div className="startup-error" role="alert">
              <p>{error}</p>
              <button className="btn" onClick={() => window.location.reload()}>
                {tr('Retry startup', 'Повторить запуск')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <footer className="startup-footer">
        <span>
          {tr('Local lineup library', 'Локальная библиотека раскидок')}
        </span>
        <span className="startup-version">v{version}</span>
      </footer>
    </section>
  );
}
