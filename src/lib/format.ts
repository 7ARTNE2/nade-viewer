export function grenadeLabel(type?: string | null) {
  const value = (type ?? '').toLowerCase();
  if (value === 'he') return 'HE';
  if (value === 'smoke') return 'Smoke';
  if (value === 'flash') return 'Flash';
  if (value === 'molotov') return 'Molotov';
  return type || '-';
}

export function formatNumber(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatClock(seconds?: number | null) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '-';
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function compactDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
