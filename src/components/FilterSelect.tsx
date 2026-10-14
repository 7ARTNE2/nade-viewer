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
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react';

export type FilterSelectOption = {
  value: string;
  label: string;
  meta?: string;
  searchText?: string;
  icon?: ReactNode;
};

type Props = {
  label: string;
  accent?: 'tournament' | 'team' | 'player';
  value: string[];
  options: FilterSelectOption[];
  onChange: (value: string[]) => void;
  selectedCountLabel: (count: number) => string;
  icon: ReactNode;
  searchPlaceholder: string;
  emptyLabel: string;
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  selectionMode?: 'multiple' | 'single';
  className?: string;
};

type MenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export default function FilterSelect({
  label,
  accent,
  value,
  options,
  onChange,
  selectedCountLabel,
  icon,
  searchPlaceholder,
  emptyLabel,
  loading = false,
  loadingLabel = 'Loading',
  disabled = false,
  selectionMode = 'multiple',
  className = '',
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
  const isSelected = (option: FilterSelectOption) =>
    option.value ? value.includes(option.value) : value.length === 0;
  const selected =
    value.length > 1
      ? { label: selectedCountLabel(value.length), meta: undefined }
      : (options.find((option) => option.value === (value[0] ?? '')) ?? {
          label: value[0] || options[0]?.label || label,
          meta: undefined,
        });
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
    if (disabled || loading) return;
    setActiveIndex(Math.max(0, options.findIndex(isSelected)));
    calculatePosition();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() =>
      searchRef.current?.focus({ preventScroll: true }),
    );
  }, [open]);

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
      if (event.type === 'scroll') calculatePosition();
      else close();
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
    if (!open) return;
    const option = optionRefs.current[activeIndex];
    const list = option?.parentElement;
    if (!option || !list) return;
    const optionRect = option.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (optionRect.top < listRect.top)
      list.scrollTop -= listRect.top - optionRect.top;
    else if (optionRect.bottom > listRect.bottom)
      list.scrollTop += optionRect.bottom - listRect.bottom;
  }, [activeIndex, open]);

  const selectOption = (option: FilterSelectOption) => {
    if (disabled || loading) return;
    if (selectionMode === 'single') {
      onChange(option.value ? [option.value] : []);
      close(true);
      return;
    }
    onChange(
      !option.value
        ? []
        : value.includes(option.value)
          ? value.filter((item) => item !== option.value)
          : [...value, option.value],
    );
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
    if (
      event.key === 'Enter' ||
      (event.key === ' ' && event.target !== searchRef.current)
    ) {
      event.preventDefault();
      const focusedIndex = optionRefs.current.findIndex(
        (node) => node === event.target,
      );
      selectOption(
        filteredOptions[focusedIndex >= 0 ? focusedIndex : activeIndex],
      );
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
    <div
      className={`tactical-filter-select ${accent ? `accent-${accent}` : ''} ${value.length ? 'has-value' : ''} ${loading ? 'is-loading' : ''} ${className}`}
    >
      <span
        className="tactical-filter-label"
        aria-hidden={selectionMode === 'single' || undefined}
      >
        {icon}
        {label}
      </span>
      <button
        ref={triggerRef}
        className="tactical-filter-trigger"
        type="button"
        disabled={disabled || loading}
        aria-busy={loading}
        role={selectionMode === 'single' ? 'combobox' : undefined}
        aria-label={selectionMode === 'single' ? label : undefined}
        data-value={selectionMode === 'single' ? (value[0] ?? '') : undefined}
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
        {loading ? (
          <span className="tactical-filter-loading">
            <span className="tactical-filter-loading-mark">
              <LoaderCircle size={15} aria-hidden="true" />
            </span>
            <span className="tactical-filter-loading-copy">
              <strong>{loadingLabel}</strong>
              <small aria-hidden="true">
                <i />
                <i />
                <i />
              </small>
            </span>
          </span>
        ) : (
          <>
            {selectionMode === 'single' && (
              <span className="tactical-filter-trigger-icon" aria-hidden="true">
                {options.find((option) => isSelected(option))?.icon ?? icon}
              </span>
            )}
            <span className="tactical-filter-value">
              <strong>{selected.label}</strong>
              {selected.meta ? <small>{selected.meta}</small> : null}
            </span>
            <ChevronDown className={open ? 'open' : ''} size={15} />
          </>
        )}
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className={`tactical-filter-menu ${className ? `${className}-menu` : ''}`}
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
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={menuId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    filteredOptions.length
                      ? `${menuId}-option-${activeIndex}`
                      : undefined
                  }
                />
              </label>
              <div
                id={menuId}
                className="tactical-filter-options"
                role="listbox"
                aria-multiselectable={selectionMode === 'multiple'}
                aria-label={label}
              >
                {filteredOptions.map((option, index) => (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    key={option.value || '__all'}
                    id={`${menuId}-option-${index}`}
                    className={`${isSelected(option) ? 'selected' : ''} ${index === activeIndex ? 'highlighted' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected(option)}
                    aria-disabled={disabled || loading}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(option)}
                  >
                    {option.icon && (
                      <span
                        className="tactical-filter-option-icon"
                        aria-hidden="true"
                      >
                        {option.icon}
                      </span>
                    )}
                    <span>
                      <strong>{option.label}</strong>
                      {option.meta ? <small>{option.meta}</small> : null}
                    </span>
                    <span
                      className="tactical-filter-checkbox"
                      aria-hidden="true"
                    >
                      {isSelected(option) ? (
                        <Check size={12} strokeWidth={2.5} />
                      ) : null}
                    </span>
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
