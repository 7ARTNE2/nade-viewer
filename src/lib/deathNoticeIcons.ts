const svgIcons = import.meta.glob('../assets/deathnotice_icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;
const pngIcons = import.meta.glob('../assets/deathnotice_icons/*.png', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;
const byFileName = new Map(
  Object.entries({ ...svgIcons, ...pngIcons }).map(([path, url]) => [
    path.split('/').pop()?.replace(/\.(svg|png)$/i, '') ?? '',
    url,
  ] as const),
);
const explicit: Record<string, string> = {
  blind: 'blind_kill',
  flash: 'blind_kill',
  headshot: 'icon_headshot',
  hs: 'icon_headshot',
  noscope: 'noscope',
  'no scope': 'noscope',
  wallbang: 'penetrate',
  penetration: 'penetrate',
  smoke: 'smoke_kill',
  'through smoke': 'smoke_kill',
  suicide: 'icon_suicide',
};
const normalize = (name?: string | null) =>
  String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ');
export function deathNoticeIcon(name?: string | null) {
  const value = normalize(name);
  const file = explicit[value] ?? value.replace(/\s+/g, '_');
  return byFileName.get(file) ?? '';
}

