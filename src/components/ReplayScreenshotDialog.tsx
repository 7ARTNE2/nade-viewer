import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, Download, LoaderCircle, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { screenshotBytes } from '../lib/replayScreenshot';
import { useModalAccessibility } from '../lib/useModalAccessibility';
import { useToast } from './Toast';
import './ReplayScreenshotDialog.css';

export default function ReplayScreenshotDialog({
  image,
  name,
  description,
  onClose,
}: {
  image: string;
  name: string;
  description: string;
  onClose: () => void;
}) {
  const { tr } = useI18n();
  const { showToast } = useToast();
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const inFlight = useRef(false);
  const close = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);
  const dialog = useModalAccessibility<HTMLDivElement>(true, close);
  const act = async (action: 'copy' | 'save') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setError('');
    if (action === 'copy') {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      setCopied(false);
    }
    try {
      const bytes = screenshotBytes(image);
      if (action === 'copy') {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
          throw new Error('Image clipboard unavailable');
        await navigator.clipboard.write([
          new ClipboardItem({
            'image/png': new Blob([bytes], { type: 'image/png' }),
          }),
        ]);
        setCopied(true);
        copiedTimer.current = setTimeout(() => {
          setCopied(false);
          copiedTimer.current = null;
        }, 2000);
        showToast(
          tr(
            'Screenshot copied. Paste it into a chat.',
            'Скриншот скопирован. Вставьте его в чат.',
          ),
          { tone: 'success' },
        );
      } else {
        const path = await invoke<string | null>('save_replay_screenshot', {
          png: Array.from(bytes),
          name,
        });
        if (path)
          showToast(tr('Screenshot saved', 'Скриншот сохранён'), {
            tone: 'success',
          });
      }
    } catch {
      setError(
        action === 'copy'
          ? tr(
              'Unable to copy the image. Save the PNG and attach it to your message.',
              'Не удалось скопировать изображение. Сохраните PNG и прикрепите к сообщению.',
            )
          : tr(
              'Unable to save the screenshot. Try again.',
              'Не удалось сохранить скриншот. Попробуйте ещё раз.',
            ),
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  return createPortal(
    <div className="modal-scrim" onMouseDown={close}>
      <div
        ref={dialog}
        className="replay-screenshot-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-screenshot-title"
        aria-describedby="replay-screenshot-description"
        aria-busy={Boolean(busy)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="replay-screenshot-title">
              {tr('Share map screenshot', 'Поделиться скриншотом карты')}
            </h2>
            <p id="replay-screenshot-description">{description}</p>
          </div>
          <button
            className="icon-btn"
            aria-label={tr('Close screenshot', 'Закрыть скриншот')}
            disabled={Boolean(busy)}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <img
          src={image}
          alt={tr('Replay map screenshot', 'Скриншот карты реплея')}
        />
        {error && (
          <p className="replay-screenshot-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <span>
            {tr(
              'Copy and paste into a chat, or save as PNG.',
              'Скопируйте и вставьте в чат или сохраните PNG.',
            )}
          </span>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => void act('save')}
          >
            {busy === 'save' ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            {tr('Save PNG', 'Сохранить PNG')}
          </button>
          <button
            className={`btn primary replay-screenshot-copy${copied ? ' copied' : ''}`}
            disabled={Boolean(busy)}
            onClick={() => void act('copy')}
          >
            {busy === 'copy' ? (
              <LoaderCircle size={15} className="spin" />
            ) : copied ? (
              <Check size={15} className="replay-screenshot-copy-check" />
            ) : (
              <Copy size={15} />
            )}
            <span aria-live="polite" aria-atomic="true">
              {copied
                ? tr('Copied', 'Скопировано')
                : tr('Copy image', 'Копировать изображение')}
            </span>
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
