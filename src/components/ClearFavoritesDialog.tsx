import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import DestructiveConfirmDialog from './DestructiveConfirmDialog';
import { useFavorites } from '../lib/favorites';
import { useI18n } from '../i18n';
import { exportFavoritesShare } from '../lib/tauri';
import { formatNumber } from '../lib/format';
import { useToast } from './Toast';

export default function ClearFavoritesDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { state, busy, clearAll } = useFavorites();
  const { tr } = useI18n();
  const { showToast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const total = Object.keys(state.favorites).length;
  return (
    <DestructiveConfirmDialog
      eyebrow={tr('All favorites', 'Всё избранное')}
      title={tr('Clear all favorites?', 'Очистить всё избранное?')}
      description={tr(
        'Saved lineups from all maps will be permanently deleted. Collections and imported libraries will remain. Export a copy first if you want to keep these lineups.',
        'Сохранённые раскидки со всех карт будут удалены без возможности отмены. Подборки и импортированные библиотеки сохранятся. Чтобы оставить копию раскидок, сначала экспортируйте избранное.',
      )}
      metadata={
        <>
          <span>{tr('Lineups to delete', 'Раскидок к удалению')}</span>
          <strong>{formatNumber(total)}</strong>
        </>
      }
      confirmLabel={tr('Clear all favorites', 'Очистить всё избранное')}
      pendingLabel={
        exporting ? tr('Exporting…', 'Экспорт…') : tr('Clearing…', 'Очистка…')
      }
      busy={busy || exporting}
      error={error}
      onCancel={onClose}
      onConfirm={async () => {
        if (lock.current || busy || !total) return;
        lock.current = true;
        setError('');
        try {
          if (await clearAll()) onClose();
          else
            setError(
              tr(
                'Could not clear favorites. Try again.',
                'Не удалось очистить избранное. Повторите попытку.',
              ),
            );
        } finally {
          lock.current = false;
        }
      }}
      secondaryAction={
        <button
          className="btn favorites-clear-export"
          type="button"
          disabled={busy || exporting}
          onClick={async () => {
            if (lock.current || busy) return;
            lock.current = true;
            setExporting(true);
            setError('');
            try {
              const path = await exportFavoritesShare({ kind: 'all' });
              if (path)
                showToast(
                  tr('Favorites file saved', 'Файл избранного сохранён'),
                  { tone: 'success' },
                );
            } catch {
              setError(
                tr(
                  'Could not export favorites. Try again.',
                  'Не удалось экспортировать избранное. Повторите попытку.',
                ),
              );
            } finally {
              lock.current = false;
              setExporting(false);
            }
          }}
        >
          <Download size={15} aria-hidden="true" />
          {tr('Export before clearing', 'Экспортировать перед очисткой')}
        </button>
      }
    />
  );
}
