import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, History } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';

export type ParserProfileId = 'v5' | 'v6';
export type ParserProfileOption = {
  id: ParserProfileId;
  installed: boolean;
  path?: string;
  filename?: string;
  version?: string;
};

type Props = {
  value: ParserProfileId;
  profiles: ParserProfileOption[];
  disabled?: boolean;
  onChange: (value: ParserProfileId) => void;
};

export default function ParserProfileSelect({
  value,
  profiles,
  disabled = false,
  onChange,
}: Props) {
  const { tr } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 270 });
  const selected = profiles.find((profile) => profile.id === value);
  const isV6 = value === 'v6';
  const label = isV6 ? 'V6' : 'V5';
  const version = selected?.version || (isV6 ? 'demoinfocs 6.0.0-rc.1' : 'demoinfocs 5.2.0');
  const close = () => setOpen(false);
  const openMenu = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.left, top: rect.bottom + 7, width: Math.max(rect.width, 270) });
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
  const options = [
    { id: 'v6' as const, title: 'V6', description: tr('Primary parser for current demos', 'Основной парсер новых демок'), icon: Cpu },
    { id: 'v5' as const, title: 'V5', description: tr('Legacy parser for older demos', 'Старый парсер для старых демок'), icon: History },
  ];
  return (
    <div className={`parser-profile-select-wrap ${disabled ? 'is-disabled' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="parser-profile-trigger"
        data-profile={value}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className="parser-profile-mark" aria-hidden="true">{isV6 ? <Cpu size={14} /> : <History size={14} />}</span>
        <span className="parser-profile-value"><strong>{label}</strong><small>{version}</small></span>
        <ChevronDown className={open ? 'open' : ''} size={15} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="parser-profile-menu" role="listbox" aria-label={tr('Parser version', 'Версия парсера')} style={{ left: position.left, top: position.top, width: position.width }}>
          <div className="parser-profile-menu-label">{tr('Choose parser', 'Выберите парсер')}</div>
          <div className="parser-profile-options">
            {options.map((option) => {
              const profile = profiles.find((item) => item.id === option.id);
              const Icon = option.icon;
              const selectedOption = option.id === value;
              const filename = profile?.filename || profile?.path?.split(/[\\/]/).pop() || (option.id === 'v6' ? 'nade-parser-v6.exe' : 'nade-parser.exe');
              return <button key={option.id} type="button" role="option" aria-selected={selectedOption} disabled={!profile?.installed} className={`${selectedOption ? 'selected' : ''} ${option.id === 'v6' ? 'is-primary' : 'is-legacy'}`} onClick={() => { if (!profile?.installed) return; onChange(option.id); close(); }}>
                <span className="parser-profile-option-mark"><Icon size={14} aria-hidden="true" /></span>
                <span className="parser-profile-option-copy">
                  <strong>{option.title}{option.id === 'v6' && <em>{tr('primary', 'основной')}</em>}</strong>
                  <small>{option.description}</small>
                  <small className="parser-profile-option-file">{filename} · {profile?.installed ? profile.version || tr('installed', 'установлен') : tr('not installed', 'не установлен')}</small>
                </span>
                {selectedOption && profile?.installed ? <Check size={15} aria-hidden="true" /> : null}
              </button>;
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
