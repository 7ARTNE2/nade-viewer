import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';

type ToastTone = 'success' | 'error' | 'info';

type ToastOptions = {
  tone?: ToastTone;
  duration?: number;
};

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  leaving: boolean;
};

type ToastContextValue = {
  showToast: (message: string, options?: ToastOptions) => void;
  toast: ToastItem | null;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') return <span className="toast-status-dot" />;
  if (tone === 'error') return <AlertTriangle size={16} />;
  return <Info size={16} />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(0);
  const pendingToast = useRef<ToastItem | null>(null);
  const [toast, setToast] = useState<ToastItem | null>(null);

  const dismiss = useCallback((id: number) => {
    setToast((current) =>
      current?.id === id && !current.leaving
        ? { ...current, leaving: true }
        : current,
    );
  }, []);

  const showToast = useCallback((message: string, options?: ToastOptions) => {
    const tone = options?.tone ?? 'info';
    const nextToast: ToastItem = {
      id: ++nextId.current,
      message,
      tone,
      duration: options?.duration ?? (tone === 'error' ? 3260 : 1960),
      leaving: false,
    };

    setToast((current) => {
      if (!current) return nextToast;

      pendingToast.current = nextToast;
      return current.leaving ? current : { ...current, leaving: true };
    });
  }, []);

  useEffect(() => {
    if (!toast?.leaving) return;

    const timeout = window.setTimeout(() => {
      setToast((current) => {
        if (current?.id !== toast.id) return current;
        const nextToast = pendingToast.current;
        pendingToast.current = null;
        return nextToast;
      });
    }, 240);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  return (
    <ToastContext.Provider
      value={{ showToast, toast, dismiss }}
    >
      {children}
    </ToastContext.Provider>
  );
}

export function ToastViewport() {
  const { toast, dismiss } = useToast();

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {toast ? <Toast key={toast.id} toast={toast} dismiss={dismiss} /> : null}
    </div>
  );
}

function Toast({
  toast,
  dismiss,
}: {
  toast: ToastItem;
  dismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(() => dismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timeout);
  }, [dismiss, toast.duration, toast.id]);

  return (
    <div className="toast-slot">
      <div
        className={`app-toast ${toast.tone} ${toast.leaving ? 'leaving' : ''}`}
        role={toast.tone === 'error' ? 'alert' : 'status'}
      >
        <span className="toast-icon">
          <ToastIcon tone={toast.tone} />
        </span>
        <span className="toast-message">{toast.message}</span>
        <button
          className="toast-dismiss"
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss notification"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
