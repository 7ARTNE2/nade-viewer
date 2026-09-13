import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, LoaderCircle, Trash2 } from 'lucide-react';
import { useModalAccessibility } from '../lib/useModalAccessibility';
import { useI18n } from '../i18n';

type Props = {
  eyebrow: string;
  title: string;
  description: string;
  metadata: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
  fallbackFocusRef?: { readonly current: HTMLElement | null };
};

// Shares the active-library deletion dialog's visual language. Mount only when open.
export default function DestructiveConfirmDialog({
  eyebrow,
  title,
  description,
  metadata,
  confirmLabel,
  pendingLabel,
  busy,
  error,
  onCancel,
  onConfirm,
  fallbackFocusRef,
}: Props) {
  const { tr } = useI18n();
  const id = useId();
  const latest = useRef({ busy, onCancel });
  useEffect(() => {
    latest.current = { busy, onCancel };
  }, [busy, onCancel]);
  const close = useCallback(() => {
    if (!latest.current.busy) latest.current.onCancel();
  }, []);
  const dialogRef = useModalAccessibility<HTMLDivElement>(true, close);

  useEffect(() => {
    // Keep focus in the dialog while both actions are disabled.
    if (busy) dialogRef.current?.focus();
    else dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [busy, dialogRef]);

  useEffect(() => {
    // The accessibility hook handles normal restoration. Uninstall removes its trigger.
    return () => {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          fallbackFocusRef?.current?.focus();
        }
      });
    };
  }, [fallbackFocusRef]);

  return createPortal(
    <div className="modal-scrim" role="presentation" onMouseDown={close}>
      <div
        ref={dialogRef}
        className="snapshot-delete-dialog tools-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (busy && event.key === 'Tab') event.preventDefault();
        }}
      >
        <div className="snapshot-delete-mark" aria-hidden="true">
          <AlertTriangle size={19} />
        </div>
        <div className="snapshot-delete-copy">
          <div className="eyebrow">{eyebrow}</div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p id={`${id}-description`}>{description}</p>
        </div>
        <div className="snapshot-delete-meta">{metadata}</div>
        {error && <p className="tools-confirm-error" role="alert">{error}</p>}
        <div className="snapshot-delete-actions">
          <button type="button" className="btn" disabled={busy} onClick={close}>
            {tr('Cancel', 'Отмена')}
          </button>
          <button
            type="button"
            className="btn danger-action"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <LoaderCircle size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
            {busy ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
