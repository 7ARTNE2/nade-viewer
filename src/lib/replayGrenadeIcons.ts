import smoke from '../assets/grenades_icons/smokegrenade.svg?raw';
import flash from '../assets/grenades_icons/flashbang.svg?raw';
import he from '../assets/grenades_icons/hegrenade.svg?raw';
import molotov from '../assets/grenades_icons/molotov.svg?raw';
import incendiary from '../assets/grenades_icons/incgrenade.svg?raw';
import decoy from '../assets/equipment_icons/decoy.svg?raw';

// Match the grenade markers and previews on the replay timeline.
export const replayGrenadeColors: Record<string, string> = {
  smoke: '#67e8f9',
  flash: '#fbbf24',
  HE: '#34d399',
  molotov: '#fb7185',
  'incendiary grenade': '#f97316',
  decoy: '#f4f6f8',
};
const coloredIcons: Record<string, string> = Object.fromEntries(
  Object.entries({
    smoke,
    flash,
    HE: he,
    molotov,
    'incendiary grenade': incendiary,
    decoy,
  }).map(([type, svg]) => [
    type,
    `data:image/svg+xml,${encodeURIComponent(
      svg.replace(/fill="white"/g, `fill="${replayGrenadeColors[type]}"`),
    )}`,
  ]),
);

export function replayGrenadeIcon(type: string): string | undefined {
  const name = type.toLowerCase().replace(/[_\s-]/g, '');
  if (name.includes('smoke')) return coloredIcons.smoke;
  if (name.includes('flash')) return coloredIcons.flash;
  if (name === 'he' || name.includes('hegrenade')) return coloredIcons.HE;
  if (name.includes('molotov')) return coloredIcons.molotov;
  if (name.includes('inc')) return coloredIcons['incendiary grenade'];
  if (name.includes('decoy')) return coloredIcons.decoy;
  return undefined;
}
