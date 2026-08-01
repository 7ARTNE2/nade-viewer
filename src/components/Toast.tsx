import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

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
};

const ToastContext = createContext<ToastContextValue | null>(null);

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') return <Check size={16} />;
  if (tone === 'error') return <AlertTriangle size={16} />;
  return <Info size={16} />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) =>
      current.map((toast) =>
        toast.id === id ? { ...toast, leaving: true } : toast,
      ),
    );
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 240);
  }, []);

  const showToast = useCallback((message: string, options?: ToastOptions) => {
    const tone = options?.tone ?? 'info';
    setToasts((current) => {
      const active = current.filter((toast) => !toast.leaving);
      if (active[0]?.message === message && active[0]?.tone === tone)
        return current;

      return [
        {
          id: ++nextId.current,
          message,
          tone,
          duration:
            options?.duration ??
            (tone === 'success' ? 2500 : tone === 'error' ? 5000 : 3500),
          leaving: false,
        },
        ...active.slice(0, 2),
      ];
    });
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-viewport" aria-live="polite">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({
  toast,
  dismiss,
}: {
  toast: ToastItem;
  dismiss: (id: number) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const previousTopRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const top = slot.getBoundingClientRect().top;
    const previousTop = previousTopRef.current;
    previousTopRef.current = top;

    if (
      previousTop === null ||
      previousTop === top ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;

    slot.animate(
      [
        { transform: `translateY(${previousTop - top}px)` },
        { transform: 'translateY(0)' },
      ],
      {
        duration: 420,
        easing: 'cubic-bezier(.16, 1, .3, 1)',
      },
    );
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => dismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timeout);
  }, [dismiss, toast.duration, toast.id]);

  return (
    <div className="toast-slot" ref={slotRef}>
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
