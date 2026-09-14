import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { useI18n } from '../i18n';

const MAX_WORKERS = 8;
const OPTIONS = Array.from({ length: MAX_WORKERS }, (_, index) => index + 1);

type MenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

type Props = {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
};

function WorkerBars({ level }: { level: number }) {
  return (
    <span className="workers-bars" aria-hidden="true">
      {OPTIONS.map((count) => (
        <i key={count} className={count <= level ? 'on' : ''} />
      ))}
    </span>
  );
}

export default function WorkersSelect({
  value,
  onChange,
  disabled = false,
}: Props) {
  const { locale, tr } = useI18n();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(value - 1);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const label = tr('Parallel workers', 'Параллельные воркеры');
  const optionMeta = (count: number) => {
    if (count === 1) return tr('Light disk load', 'Лёгкая нагрузка на диск');
    if (count === 2) return tr('Recommended', 'Рекомендуется');
    if (count === MAX_WORKERS)
      return tr('Max throughput', 'Максимальная скорость');
    return null;
  };
  const workerWord = (count: number) => {
    if (locale === 'ru')
      return count === 1 ? 'воркер' : count < 5 ? 'воркера' : 'воркеров';
    return count === 1 ? 'worker' : 'workers';
  };
  const triggerMeta = optionMeta(value) ?? workerWord(value);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus)
      window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const calculatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const edge = 10;
    const gap = 7;
    const width = Math.min(
      Math.max(rect.width, 236),
      window.innerWidth - edge * 2,
    );
    const left = Math.max(
      edge,
      Math.min(rect.left, window.innerWidth - width - edge),
    );
    const spaceBelow = window.innerHeight - rect.bottom - edge - gap;
    const spaceAbove = rect.top - edge - gap;
    const useAbove = spaceBelow < 300 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      160,
      Math.min(372, useAbove ? spaceAbove : spaceBelow),
    );
    setPosition({
      left,
      top: useAbove ? rect.top - gap : rect.bottom + gap,
      width,
      maxHeight,
    });
  };

  const openMenu = () => {
    if (disabled) return;
    calculatePosition();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(0, Math.min(value - 1, OPTIONS.length - 1)));
    window.requestAnimationFrame(() => menuRef.current?.focus());
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        (!triggerRef.current?.contains(target) &&
          !menuRef.current?.contains(target))
      )
        close();
    };
    const onViewportChange = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const selectOption = (count: number) => {
    onChange(count);
    close(true);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (index) => (index + direction + OPTIONS.length) % OPTIONS.length,
      );
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : OPTIONS.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      selectOption(OPTIONS[activeIndex]);
    }
  };

  const menuStyle = position
    ? ({
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: position.maxHeight,
        transform:
          position.top < (triggerRef.current?.getBoundingClientRect().top ?? 0)
            ? 'translateY(-100%)'
            : undefined,
      } as CSSProperties)
    : undefined;

  return (
    <div className={`workers-select ${disabled ? 'is-disabled' : ''}`}>
      <button
        ref={triggerRef}
        className="workers-select-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="workers-select-mark">
          <Cpu size={14} aria-hidden="true" />
        </span>
        <span className="workers-select-value">
          <strong>{value}</strong>
          <small>{triggerMeta}</small>
        </span>
        <WorkerBars level={value} />
        <ChevronDown
          className={open ? 'open' : ''}
          size={15}
          aria-hidden="true"
        />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="workers-select-menu"
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              style={menuStyle}
              onKeyDown={handleMenuKeyDown}
              onBlur={(event) => {
                if (
                  !event.relatedTarget ||
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  close();
              }}
            >
              <div className="workers-select-menu-label">
                {tr('Worker limit', 'Лимит воркеров')}
              </div>
              <div
                id={menuId}
                className="workers-select-options"
                role="listbox"
                aria-label={label}
              >
                {OPTIONS.map((count, index) => (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    key={count}
                    className={`${count === value ? 'selected' : ''} ${index === activeIndex ? 'highlighted' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={count === value}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(count)}
                  >
                    <span className="workers-select-option-copy">
                      <strong>{count}</strong>
                      <WorkerBars level={count} />
                    </span>
                    <span className="workers-select-option-meta">
                      {optionMeta(count) ?? workerWord(count)}
                    </span>
                    {count === value ? (
                      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                    ) : null}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
