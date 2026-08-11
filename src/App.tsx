import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Database,
  Download,
  Ellipsis,
  FolderOpen,
  Map,
  Pencil,
  RotateCw,
  Sparkles,
  Trash2,
  GraduationCap,
  Upload,
  X,
} from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import {
  deleteImport,
  exportCoreNades,
  getActiveImport,
  getOnboardingState,
  listImports,
  resetOnboarding,
  setActiveImport,
  updateImportLabel,
  completeOnboarding,
} from './lib/tauri';
import { compactDate, formatNumber } from './lib/format';
import { startWindowActiveTracking } from './lib/windowActive';
import type { ImportSummary } from './types/domain';
import { version } from '../package.json';
import HomePage from './pages/HomePage';
import ImportPage from './pages/ImportPage';
import MapPage from './pages/MapPage';
import GrenadePage from './pages/GrenadePage';
import Tooltip from './components/Tooltip';
import OnboardingModal from './components/OnboardingModal';
import { useI18n } from './i18n';
import { useModalAccessibility } from './lib/useModalAccessibility';
import { ToastViewport, useToast } from './components/Toast';

function importFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function snapshotDisplayName(snapshot: ImportSummary) {
  return snapshot.label?.trim() || importFileName(snapshot.source_path);
}

function Shell() {
  const { locale, setLocale, tr, count } = useI18n();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeImport, setActive] = useState<ImportSummary | null>(null);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [coreTransferBusy, setCoreTransferBusy] = useState(false);
  const [coreTransferStatus, setCoreTransferStatus] = useState<string | null>(
    null,
  );
  const [snapshotMenuOpen, setSnapshotMenuOpen] = useState(false);
  const [libraryActionsOpen, setLibraryActionsOpen] = useState(false);
  const [editingSnapshotId, setEditingSnapshotId] = useState<number | null>(
    null,
  );
  const [editingLabel, setEditingLabel] = useState('');
  const [deleteSnapshotOpen, setDeleteSnapshotOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const importsRequestRef = useRef(0);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const closeDeleteModal = useCallback(() => setDeleteSnapshotOpen(false), []);
  const deleteDialogRef = useModalAccessibility<HTMLDivElement>(
    deleteSnapshotOpen,
    closeDeleteModal,
  );

  const restartTutorial = async () => {
    await resetOnboarding();
    setOnboardingOpen(true);
  };

  const refreshImports = useCallback(async () => {
    const requestId = ++importsRequestRef.current;
    try {
      const [active, all, onboarding] = await Promise.allSettled([
        getActiveImport(),
        listImports(),
        getOnboardingState(),
      ]);
      if (importsRequestRef.current !== requestId) return;
      if (active.status === 'fulfilled') {
        setActive(active.value);
        if (!active.value && location.pathname !== '/import')
          navigate('/import', { replace: true });
      }
      if (all.status === 'fulfilled')
        setImports(Array.isArray(all.value) ? all.value : []);
      if (onboarding.status === 'fulfilled')
        setOnboardingOpen(!onboarding.value.completed);
      const failures = [active, all, onboarding].filter(
        (result) => result.status === 'rejected',
      );
      if (failures.length) {
        failures.forEach((failure) =>
          console.error('Unable to refresh application state', failure.reason),
        );
        setOperationError(
          tr(
            'Some library data could not be refreshed',
            'Не удалось обновить часть данных библиотеки',
          ),
        );
      } else {
        setOperationError(null);
      }
    } finally {
      if (importsRequestRef.current === requestId) setLoading(false);
    }
  }, [locale, location.pathname, navigate]);

  useEffect(() => {
    refreshImports().catch(() => setLoading(false));
  }, [refreshImports]);

  useEffect(() => startWindowActiveTracking(), []);

  const checkForUpdate = useCallback(
    async (manual = false) => {
      if (!('__TAURI_INTERNALS__' in window)) {
        if (manual)
          showToast(
            tr(
              'Updates are available in the installed application',
              'Обновления доступны в установленном приложении',
            ),
          );
        return;
      }

      setUpdateBusy(true);
      try {
        const update = await check();
        setAvailableUpdate(update);
        if (manual && !update)
          showToast(
            tr('You already have the latest version', 'У вас последняя версия'),
          );
      } catch (error) {
        console.error(error);
        if (manual)
          showToast(
            tr(
              'Could not check for updates',
              'Не удалось проверить обновления',
            ),
            { tone: 'error' },
          );
      } finally {
        setUpdateBusy(false);
      }
    },
    [showToast, tr],
  );

  const installUpdate = async () => {
    if (!availableUpdate) return;
    setUpdateBusy(true);
    try {
      await availableUpdate.downloadAndInstall();
    } catch (error) {
      console.error(error);
      setUpdateBusy(false);
      showToast(
        tr('Could not install update', 'Не удалось установить обновление'),
        {
          tone: 'error',
        },
      );
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdate();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate]);

  useEffect(() => {
    if (!coreTransferStatus && !operationError) return;
    showToast(operationError ?? coreTransferStatus!, {
      tone: operationError ? 'error' : 'success',
      duration: 5000,
    });
    setCoreTransferStatus(null);
    setOperationError(null);
  }, [coreTransferStatus, operationError, showToast]);

  const switchImport = async (id: number) => {
    const isMapWorkspace = location.pathname.startsWith('/map/');
    setOperationError(null);
    try {
      const next = await setActiveImport(id);
      const all = await listImports();
      setActive(next);
      setImports(Array.isArray(all) ? all : []);
      setSnapshotMenuOpen(false);
      setLibraryActionsOpen(false);
      setEditingSnapshotId(null);
      if (!isMapWorkspace) navigate('/maps');
      showToast(tr('Library switched', 'Библиотека переключена'), {
        tone: 'success',
      });
    } catch (error) {
      console.error(error);
      setOperationError(
        tr('Could not switch library', 'Не удалось переключить библиотеку'),
      );
    }
  };

  const saveSnapshotLabel = async (snapshot: ImportSummary) => {
    setOperationError(null);
    try {
      const updated = await updateImportLabel(snapshot.id, editingLabel);
      setImports((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (activeImport?.id === updated.id) setActive(updated);
      setEditingSnapshotId(null);
      setEditingLabel('');
      showToast(tr('Library renamed', 'Библиотека переименована'), {
        tone: 'success',
      });
    } catch (error) {
      console.error(error);
      setOperationError(
        tr('Could not rename library', 'Не удалось переименовать библиотеку'),
      );
    }
  };

  const confirmDeleteSnapshot = async () => {
    if (!activeImport) return;
    const deletedName = snapshotDisplayName(activeImport);
    setOperationError(null);
    try {
      const next = await deleteImport(activeImport.id);
      setDeleteSnapshotOpen(false);
      setLibraryActionsOpen(false);
      await refreshImports();
      navigate(next ? '/maps' : '/import', { replace: true });
      showToast(
        tr(
          `Library “${deletedName}” deleted`,
          `Библиотека «${deletedName}» удалена`,
        ),
        { tone: 'success' },
      );
    } catch (error) {
      console.error(error);
      setOperationError(
        tr('Could not delete library', 'Не удалось удалить библиотеку'),
      );
    }
  };

  const handleCoreExport = async () => {
    setCoreTransferBusy(true);
    setCoreTransferStatus(null);
    try {
      const report = await exportCoreNades();
      if (report)
        setCoreTransferStatus(
          count(
            report.grenade_count,
            'grenade saved',
            'grenades saved',
            'граната сохранена',
            'гранаты сохранены',
            'гранат сохранено',
          ),
        );
    } catch (error) {
      console.error(error);
      setOperationError(tr('Export failed', 'Ошибка экспорта'));
    } finally {
      setCoreTransferBusy(false);
    }
  };

  const mapsRouteActive =
    location.pathname === '/' ||
    location.pathname === '/maps' ||
    location.pathname.startsWith('/map/') ||
    location.pathname.startsWith('/grenade/');
  const importRouteActive = location.pathname === '/import';

  if (loading) {
    return (
      <div className="boot-screen viewer-boot">
        <div className="viewer-loader">
          <Sparkles size={20} />
        </div>
        <div className="boot-title">
          Nade Viewer <span className="boot-version">v{version}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell viewer-shell topnav-shell">
      <main className="app-main viewer-main">
        <header className="viewer-topbar">
          <div className="topbar-navigation">
            <button
              className="topbar-brand"
              onClick={() => navigate('/maps')}
              aria-label={tr('Nade Viewer home', 'Главная Nade Viewer')}
            >
              <span className="viewer-brand-mark">NV</span>
              <span className="topbar-brand-copy">
                <strong>Nade Viewer</strong>
                <small>v{version}</small>
              </span>
            </button>
            <span className="topbar-divider" />
            <button
              className={`topbar-nav-link ${mapsRouteActive ? 'active' : ''}`}
              onClick={() => navigate('/maps')}
            >
              <Map size={16} />
              <span>{tr('Maps', 'Карты')}</span>
            </button>
            <button
              className={`topbar-nav-link ${importRouteActive ? 'active' : ''}`}
              onClick={() => navigate('/import')}
            >
              <Download size={16} />
              <span>{tr('Import library', 'Импорт')}</span>
            </button>
            <button
              className="topbar-nav-link"
              onClick={() =>
                restartTutorial().catch((error) => {
                  console.error(error);
                  setOperationError(
                    tr(
                      'Could not restart tutorial',
                      'Не удалось перезапустить обучение',
                    ),
                  );
                })
              }
            >
              <GraduationCap size={16} />
              <span>{tr('Tutorial', 'Обучение')}</span>
            </button>
            <div
              className="language-switch"
              aria-label={tr('Language', 'Язык')}
            >
              <button
                className={locale === 'en' ? 'active' : ''}
                onClick={() => setLocale('en')}
                aria-pressed={locale === 'en'}
              >
                EN
              </button>
              <button
                className={locale === 'ru' ? 'active' : ''}
                onClick={() => setLocale('ru')}
                aria-pressed={locale === 'ru'}
              >
                RU
              </button>
            </div>
          </div>
          <ToastViewport />
          <div className="topbar-actions">
            {activeImport ? (
              <div
                className="snapshot-picker"
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    setSnapshotMenuOpen(false);
                }}
              >
                <button
                  className={`snapshot-trigger active-library-trigger ${snapshotMenuOpen ? 'active' : ''}`}
                  onClick={() => setSnapshotMenuOpen((open) => !open)}
                  aria-expanded={snapshotMenuOpen}
                  aria-haspopup="dialog"
                  aria-controls="library-picker-popover"
                  data-tip={activeImport.source_path}
                  data-tip-pos="bottom"
                >
                  <Database size={14} />
                  <span className="active-library-id">
                    {tr('Library', 'Библиотека')} #{activeImport.id}
                  </span>
                  <strong>{snapshotDisplayName(activeImport)}</strong>
                  <span className="active-library-count">
                    <b>{formatNumber(activeImport.grenade_count)}</b>
                    <small>
                      {count(
                        activeImport.grenade_count,
                        'grenade',
                        'grenades',
                        'граната',
                        'гранаты',
                        'гранат',
                      ).replace(/^\d+[\s\u00a0]*/, '')}
                    </small>
                  </span>
                  <ChevronDown size={14} />
                </button>
                {snapshotMenuOpen ? (
                  <div
                    className="snapshot-menu"
                    id="library-picker-popover"
                    role="dialog"
                    aria-label={tr(
                      'Choose or rename library',
                      'Выбрать или переименовать библиотеку',
                    )}
                  >
                    {imports.map((item) => {
                      const isEditing = editingSnapshotId === item.id;
                      return (
                        <div
                          key={item.id}
                          className={`snapshot-option ${item.id === activeImport.id ? 'active' : ''} ${isEditing ? 'editing' : ''}`}
                        >
                          <span className="snapshot-id">#{item.id}</span>
                          {isEditing ? (
                            <form
                              className="snapshot-edit-row"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveSnapshotLabel(item);
                              }}
                            >
                              <input
                                className="snapshot-edit-input"
                                value={editingLabel}
                                onChange={(event) =>
                                  setEditingLabel(event.target.value)
                                }
                                placeholder={importFileName(item.source_path)}
                                aria-label={tr(
                                  `Library name for ${snapshotDisplayName(item)}`,
                                  `Название библиотеки ${snapshotDisplayName(item)}`,
                                )}
                                autoFocus
                              />
                              <button
                                className="snapshot-edit-action"
                                type="submit"
                                aria-label={tr(
                                  'Save library name',
                                  'Сохранить название библиотеки',
                                )}
                              >
                                <Check size={14} />
                              </button>
                              <button
                                className="snapshot-edit-action"
                                type="button"
                                onClick={() => setEditingSnapshotId(null)}
                                aria-label={tr(
                                  'Cancel renaming',
                                  'Отменить переименование',
                                )}
                              >
                                <X size={14} />
                              </button>
                            </form>
                          ) : (
                            <>
                              <button
                                className="snapshot-option-main"
                                type="button"
                                onClick={() =>
                                  item.id === activeImport.id
                                    ? setSnapshotMenuOpen(false)
                                    : switchImport(item.id)
                                }
                              >
                                <span className="snapshot-main">
                                  <strong>{snapshotDisplayName(item)}</strong>
                                  <small>
                                    {count(
                                      item.grenade_count,
                                      'grenade',
                                      'grenades',
                                      'граната',
                                      'гранаты',
                                      'гранат',
                                    )}
                                  </small>
                                </span>
                                {item.id === activeImport.id ? (
                                  <span className="snapshot-current">
                                    {tr('Active', 'Активна')}
                                  </span>
                                ) : null}
                              </button>
                              <button
                                className="snapshot-rename-btn"
                                type="button"
                                onClick={() => {
                                  setEditingSnapshotId(item.id);
                                  setEditingLabel(item.label?.trim() || '');
                                }}
                                aria-label={tr(
                                  `Rename ${snapshotDisplayName(item)}`,
                                  `Переименовать ${snapshotDisplayName(item)}`,
                                )}
                              >
                                <Pencil size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              <button
                className="btn primary"
                onClick={() => navigate('/import')}
              >
                <FolderOpen size={16} />
                {tr('Import data', 'Импортировать')}
              </button>
            )}
            <div
              className="library-actions-menu"
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  setLibraryActionsOpen(false);
              }}
            >
              <button
                className={`icon-btn ${libraryActionsOpen ? 'active' : ''}`}
                type="button"
                onClick={() => setLibraryActionsOpen((open) => !open)}
                aria-expanded={libraryActionsOpen}
                aria-label={tr('Library actions', 'Действия с библиотекой')}
                data-tip={tr('Library actions', 'Действия с библиотекой')}
              >
                <Ellipsis size={17} />
              </button>
              {libraryActionsOpen ? (
                <div className="library-actions-popover">
                  {activeImport ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLibraryActionsOpen(false);
                        void handleCoreExport();
                      }}
                      disabled={coreTransferBusy}
                    >
                      <Upload size={15} />
                      {coreTransferBusy
                        ? tr('Exporting Core Nades', 'Экспорт избранных гранат')
                        : tr('Export Core Nades', 'Экспорт избранных гранат')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                  >
                    <RotateCw size={15} />
                    {tr(
                      'Refresh application page',
                      'Обновить страницу приложения',
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void checkForUpdate(true)}
                    disabled={updateBusy}
                  >
                    <Download size={15} />
                    {updateBusy
                      ? tr('Checking for updates', 'Проверка обновлений')
                      : tr('Check for updates', 'Проверить обновления')}
                  </button>
                  {activeImport ? (
                    <button
                      className="danger"
                      type="button"
                      onClick={() => {
                        setLibraryActionsOpen(false);
                        setDeleteSnapshotOpen(true);
                      }}
                    >
                      <Trash2 size={15} />
                      {tr(
                        'Delete active library',
                        'Удалить активную библиотеку',
                      )}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div className="view-frame viewer-frame">
          <Routes>
            <Route
              path="/"
              element={
                <Navigate
                  to={activeImport ? '/maps' : '/import'}
                  replace
                />
              }
            />
            <Route
              path="/maps"
              element={
                activeImport ? (
                  <HomePage activeImportId={activeImport.id} />
                ) : (
                  <Navigate to="/import" replace />
                )
              }
            />
            <Route
              path="/import"
              element={
                <ImportPage
                  onImported={refreshImports}
                  lastImport={imports[0] ?? null}
                />
              }
            />
            <Route
              path="/map/:mapName"
              element={
                activeImport ? (
                  <MapPage activeImportId={activeImport.id} />
                ) : (
                  <Navigate to="/import" replace />
                )
              }
            />
            <Route
              path="/grenade/:id"
              element={
                activeImport ? (
                  <GrenadePage />
                ) : (
                  <Navigate to="/import" replace />
                )
              }
            />
            <Route
              path="*"
              element={
                <Navigate
                  to={activeImport ? '/maps' : '/import'}
                  replace
                />
              }
            />
          </Routes>
        </div>
      </main>

      {availableUpdate ? (
        <div className="app-update-notice" role="status">
          <div>
            <strong>
              {tr(
                `Version ${availableUpdate.version} is ready`,
                `Доступна версия ${availableUpdate.version}`,
              )}
            </strong>
            <span>
              {tr(
                'The app will close while Windows installs the update.',
                'Приложение закроется, пока Windows устанавливает обновление.',
              )}
            </span>
          </div>
          <button
            className="btn primary"
            type="button"
            onClick={() => void installUpdate()}
            disabled={updateBusy}
          >
            <Download size={15} />
            {updateBusy
              ? tr('Installing', 'Установка')
              : tr('Install update', 'Установить')}
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={() => setAvailableUpdate(null)}
            aria-label={tr('Later', 'Позже')}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}

      {deleteSnapshotOpen && activeImport ? (
        <div
          className="modal-scrim"
          role="presentation"
          onMouseDown={() => setDeleteSnapshotOpen(false)}
        >
          <div
            ref={deleteDialogRef}
            className="snapshot-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-library-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="snapshot-delete-mark">
              <AlertTriangle size={19} />
            </div>
            <div className="snapshot-delete-copy">
              <div className="eyebrow">
                {tr('Delete library', 'Удаление библиотеки')}
              </div>
              <h2 id="delete-library-title">
                {snapshotDisplayName(activeImport)}
              </h2>
              <p>
                {tr(
                  `Library #${activeImport.id} and ${formatNumber(activeImport.grenade_count)} grenade rows will be removed.`,
                  `Библиотека #${activeImport.id} и ${formatNumber(activeImport.grenade_count)} записей будут удалены.`,
                )}
              </p>
            </div>
            <div className="snapshot-delete-meta">
              <span>{tr('Source', 'Источник')}</span>
              <strong>{importFileName(activeImport.source_path)}</strong>
              <span>{tr('Imported', 'Импортирована')}</span>
              <strong>{compactDate(activeImport.imported_at)}</strong>
            </div>
            <div className="snapshot-delete-actions">
              <button
                className="btn"
                onClick={() => setDeleteSnapshotOpen(false)}
              >
                {tr('Cancel', 'Отмена')}
              </button>
              <button
                className="btn danger-action"
                onClick={confirmDeleteSnapshot}
              >
                <Trash2 size={15} />
                {tr('Delete', 'Удалить')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {onboardingOpen ? (
        <OnboardingModal
          onComplete={async () => {
            await completeOnboarding();
            setOnboardingOpen(false);
          }}
          onShowImport={() => navigate('/import')}
          onShowMaps={() => navigate('/maps')}
          activeImport={Boolean(activeImport)}
          pathname={location.pathname}
        />
      ) : null}
      <Tooltip />
    </div>
  );
}

export default function App() {
  return <Shell />;
}
