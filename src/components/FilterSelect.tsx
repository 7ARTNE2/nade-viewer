import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

export type FilterSelectOption = {
  value: string;
  label: string;
  meta?: string;
  searchText?: string;
};

type Props = {
  label: string;
  value: string;
  options: FilterSelectOption[];
  onChange: (value: string) => void;
  icon: ReactNode;
  searchPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
};

type MenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export default function FilterSelect({
  label,
  value,
  options,
  onChange,
  icon,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
}: Props) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selected = options.find((option) => option.value === value) ?? {
    value,
    label: value || options[0]?.label || label,
  };
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) => {
      if (!option.value) return true;
      return `${option.label} ${option.meta ?? ''} ${option.searchText ?? ''}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [options, query]);
  const hasMatchingValue = filteredOptions.some((option) => option.value);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery('');
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
      Math.max(rect.width, 248),
      window.innerWidth - edge * 2,
    );
    const left = Math.max(
      edge,
      Math.min(rect.left, window.innerWidth - width - edge),
    );
    const spaceBelow = window.innerHeight - rect.bottom - edge - gap;
    const spaceAbove = rect.top - edge - gap;
    const useAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      160,
      Math.min(330, useAbove ? spaceAbove : spaceBelow),
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
    const selectedIndex = filteredOptions.findIndex(
      (option) => option.value === value,
    );
    setActiveIndex(Math.max(0, selectedIndex));
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((index) =>
      Math.min(index, Math.max(0, filteredOptions.length - 1)),
    );
  }, [filteredOptions.length, open]);

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

  const selectOption = (option: FilterSelectOption) => {
    onChange(option.value);
    close(true);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (!filteredOptions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (index) =>
          (index + direction + filteredOptions.length) % filteredOptions.length,
      );
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : filteredOptions.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      selectOption(filteredOptions[activeIndex]);
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
    <div className={`tactical-filter-select ${value ? 'has-value' : ''}`}>
      <span className="tactical-filter-label">
        {icon}
        {label}
      </span>
      <button
        ref={triggerRef}
        className="tactical-filter-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="tactical-filter-value">
          <strong>{selected.label}</strong>
          {selected.meta ? <small>{selected.meta}</small> : null}
        </span>
        <ChevronDown className={open ? 'open' : ''} size={15} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="tactical-filter-menu"
              role="dialog"
              aria-label={label}
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
              <label className="tactical-filter-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                />
              </label>
              <div
                id={menuId}
                className="tactical-filter-options"
                role="listbox"
                aria-label={label}
              >
                {filteredOptions.map((option, index) => (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    key={option.value || '__all'}
                    className={`${option.value === value ? 'selected' : ''} ${index === activeIndex ? 'highlighted' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(option)}
                  >
                    <span>
                      <strong>{option.label}</strong>
                      {option.meta ? <small>{option.meta}</small> : null}
                    </span>
                    {option.value === value ? (
                      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                    ) : null}
                  </button>
                ))}
                {query.trim() && !hasMatchingValue ? (
                  <span className="tactical-filter-empty">{emptyLabel}</span>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
