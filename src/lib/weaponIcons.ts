const icons = import.meta.glob('../assets/equipment_icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;
const byFileName = new Map(
  Object.entries(icons).map(
    ([path, url]) =>
      [
        path
          .split('/')
          .pop()
          ?.replace(/\.svg$/i, '') ?? '',
        url,
      ] as const,
  ),
);
const aliases: Record<string, string> = {
  'ak-47': 'ak47',
  ak47: 'ak47',
  'pp-bizon': 'bizon',
  bizon: 'bizon',
  'cz75-auto': 'cz75a',
  'desert eagle': 'deagle',
  deagle: 'deagle',
  'dual berettas': 'elite',
  'five-seven': 'fiveseven',
  'galil ar': 'galilar',
  galil: 'galilar',
  'glock-18': 'glock',
  m4a4: 'm4a1',
  'm4a1-s': 'm4a1_silencer',
  'mac-10': 'mac10',
  'mag-7': 'mag7',
  'mp5-sd': 'mp5sd',
  'r8 revolver': 'revolver',
  'sawed-off': 'sawedoff',
  'sg 553': 'sg556',
  'ssg 08': 'ssg08',
  'ump-45': 'ump45',
  'usp-s': 'usp_silencer',
  usp: 'usp_silencer',
  zeus: 'taser',
  'zeus x27': 'taser',
  bayonet: 'bayonet',
  knife: 'knife',
  bomb: 'c4',
  c4: 'c4',
  'planted c4': 'planted_c4',
  'he grenade': 'hegrenade',
  hegrenade: 'hegrenade',
  flashbang: 'flashbang',
  'smoke grenade': 'smokegrenade',
  smokegrenade: 'smokegrenade',
  molotov: 'molotov',
  'incendiary grenade': 'incgrenade',
  incgrenade: 'incgrenade',
  decoy: 'decoy',
  'defuse kit': 'defuser',
  defuser: 'defuser',
  kevlar: 'kevlar',
  helmet: 'helmet',
};
const normalize = (name?: string | null) =>
  String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
export function weaponIcon(name?: string | null) {
  const value = normalize(name);
  const file = aliases[value] ?? value.replace(/\s+/g, '_').replace(/-/g, '_');
  if (byFileName.has(file)) return byFileName.get(file)!;
  const compact = value.replace(/[^a-z0-9]/g, '');
  for (const [key, url] of byFileName) {
    if (key.replace(/[^a-z0-9]/g, '') === compact) return url;
  }
  return byFileName.get('world') ?? '';
}
