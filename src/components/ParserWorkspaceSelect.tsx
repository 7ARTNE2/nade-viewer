import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Database } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';

type WorkspaceId = 'production' | 'test';
type Props = { value: WorkspaceId; counts: { production: number; test: number }; disabled?: boolean; onChange: (value: WorkspaceId) => void };

export default function ParserWorkspaceSelect({ value, counts, disabled = false, onChange }: Props) {
  const { tr } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260 });
  const label = value === 'production' ? 'Production' : tr('Test', 'Тестовая');
  const options = [
    { id: 'test' as const, name: tr('Test', 'Тестовая'), description: tr('Isolated parser data', 'Изолированные данные парсера') },
    { id: 'production' as const, name: 'Production', description: tr('Main library workspace', 'Основная база библиотеки') },
  ];
  const close = () => setOpen(false);
  const openMenu = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.left, top: rect.bottom + 7, width: Math.max(rect.width, 260) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))) close();
    };
    const onViewportChange = () => close();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);
  return (
    <div className={`parser-workspace-select ${disabled ? 'is-disabled' : ''}`}>
      <button ref={triggerRef} type="button" className="parser-workspace-trigger" data-workspace={value} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? close() : openMenu())}>
        <span className="workers-select-mark" aria-hidden="true"><Database size={14} /></span>
        <span className="workers-select-value"><strong>{label}</strong><small>{counts[value].toLocaleString()} {tr('raw throws', 'исходных бросков')}</small></span>
        <ChevronDown className={open ? 'open' : ''} size={15} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div ref={menuRef} className="parser-workspace-menu" role="listbox" aria-label={tr('Parser workspace', 'Рабочая база парсера')} style={{ left: position.left, top: position.top, width: position.width }}>
          <div className="parser-workspace-menu-label">{tr('Choose workspace', 'Выберите workspace')}</div>
          <div className="parser-workspace-options">
            {options.map((option) => (
              <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={`${option.id === value ? 'selected' : ''} ${option.id === 'production' ? 'is-production' : ''}`} onClick={() => { onChange(option.id); close(); }}>
                <span className="parser-workspace-option-mark"><Database size={14} aria-hidden="true" /></span>
                <span className="parser-workspace-option-copy"><strong>{option.name}</strong><small>{option.description} · {counts[option.id].toLocaleString()} {tr('raw throws', 'исходных бросков')}</small></span>
                {option.id === value ? <Check size={15} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </div>, document.body) : null}
    </div>
  );
}
