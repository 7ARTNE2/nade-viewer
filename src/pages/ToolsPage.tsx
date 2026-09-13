import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Package,
  Puzzle,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { toolPlugins, type ToolPluginInfo } from '../lib/toolPlugins';

type Props = { refreshImports?: () => Promise<void> };
type PluginState = { info?: ToolPluginInfo; error?: string };

export default function ToolsPage({ refreshImports }: Props) {
  const { tr } = useI18n();
  const { pluginId } = useParams<{ pluginId: string }>();
  const [states, setStates] = useState<Record<string, PluginState>>({});
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (pluginId) return;
    let active = true;
    let generation = 0;
    const refreshCatalog = () => {
      const request = ++generation;
      for (const plugin of toolPlugins) {
        void plugin.getInfo().then(
          (info) => {
            if (active && request === generation) {
              setStates((old) => ({ ...old, [plugin.id]: { info } }));
            }
          },
          (error: unknown) => {
            if (active && request === generation) {
              setStates((old) => ({
                ...old,
                [plugin.id]: { error: String(error) },
              }));
            }
          },
        );
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshCatalog();
    };
    setStates({});
    refreshCatalog();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pluginId, revision]);

  if (pluginId) {
    const plugin = toolPlugins.find((entry) => entry.id === pluginId);
    const PluginView = plugin?.View;
    return (
      <section className="tools-view">
        <nav
          className="tools-breadcrumb"
          aria-label={tr('Plugin navigation', 'Навигация по плагинам')}
        >
          <Link to="/tools" className="tools-back-link">
            <ArrowLeft size={15} />
            {tr('All plugins', 'Все плагины')}
          </Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">
            {plugin?.name ?? tr('Plugin not found', 'Плагин не найден')}
          </span>
        </nav>
        {PluginView ? (
          <PluginView key={pluginId} refreshImports={refreshImports} />
        ) : (
          <div className="tools-catalog-empty">
            <Puzzle size={28} />
            <h1>{tr('Plugin not found', 'Плагин не найден')}</h1>
            <p>
              {tr(
                'Choose an available plugin from the Tools catalog.',
                'Выберите доступный плагин в каталоге инструментов.',
              )}
            </p>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="tools-view">
      <header className="tools-header tools-catalog-header">
        <div>
          <span className="tools-kicker">TOOLS / PLUGINS</span>
          <h1>{tr('Tools', 'Инструменты')}</h1>
          <p>
            {tr(
              'Choose a plugin to open its workspace or manage its installation.',
              'Выберите плагин, чтобы открыть его рабочее пространство или управлять установкой.',
            )}
          </p>
        </div>
        <div className="tools-health">
          <Puzzle size={16} />
          <span>{tr('Plugin catalog', 'Каталог плагинов')}</span>
        </div>
      </header>
      <div className="tools-catalog-heading">
        <h2>
          {tr('Available plugins', 'Доступные плагины')}{' '}
          <span>{toolPlugins.length}</span>
        </h2>
        <button
          className="btn"
          type="button"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
          {tr('Refresh status', 'Обновить статус')}
        </button>
      </div>
      <div className="tools-plugin-catalog">
        {toolPlugins.map((plugin) => {
          const state = states[plugin.id];
          const info = state?.info;
          const Icon = plugin.icon;
          const checking = !info && !state?.error;
          const status = checking
            ? tr('Checking...', 'Проверка...')
            : state?.error
              ? tr('Status unavailable', 'Статус недоступен')
              : info?.installed
                ? tr('Installed', 'Установлен')
                : tr('Not installed', 'Не установлен');
          return (
            <article
              key={plugin.id}
              className="tools-plugin-card"
              aria-labelledby={`plugin-${plugin.id}`}
            >
              <div className="tools-plugin-card-top">
                <div className="tools-plugin-icon">
                  <Icon size={24} />
                </div>
                <span
                  className={`tools-plugin-state ${info?.installed ? 'is-installed' : ''}`}
                  role="status"
                >
                  {info?.installed ? (
                    <CheckCircle2 size={13} />
                  ) : state?.error ? (
                    <XCircle size={13} />
                  ) : (
                    <Package size={13} />
                  )}
                  {status}
                </span>
              </div>
              <span className="tools-plugin-category">
                {tr(...plugin.category)}
              </span>
              <h2 id={`plugin-${plugin.id}`}>{plugin.name}</h2>
              <p className="tools-plugin-description">
                {tr(...plugin.description)}
              </p>
              <ul className="tools-plugin-features">
                {plugin.features.map((feature) => (
                  <li key={feature[0]}>{tr(...feature)}</li>
                ))}
              </ul>
              {state?.error && (
                <p className="tools-plugin-error" role="alert">
                  {state.error}
                </p>
              )}
              <div className="tools-plugin-card-footer">
                <span>
                  {info?.installed && info.version
                    ? `v${info.version}`
                    : tr('Local plugin', 'Локальный плагин')}
                </span>
                <Link
                  className={`btn ${info?.installed ? '' : 'primary'}`}
                  to={`/tools/${plugin.id}`}
                  aria-label={`${info?.installed ? tr('Open', 'Открыть') : tr('Set up', 'Настроить')} ${plugin.name}`}
                >
                  {info?.installed
                    ? tr('Open workspace', 'Открыть')
                    : tr('Set up plugin', 'Настроить плагин')}
                  <ArrowUpRight size={15} />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
