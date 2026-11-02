import smoke from '../assets/grenades_icons/smokegrenade.svg';
import flash from '../assets/grenades_icons/flashbang.svg';
import he from '../assets/grenades_icons/hegrenade.svg';
import molotov from '../assets/grenades_icons/molotov.svg';
import incendiary from '../assets/grenades_icons/incgrenade.svg';
import decoy from '../assets/equipment_icons/decoy.svg';

export function replayGrenadeIcon(type: string): string | undefined {
  const name = type.toLowerCase().replace(/[_\s-]/g, '');
  if (name.includes('smoke')) return smoke;
  if (name.includes('flash')) return flash;
  if (name === 'he' || name.includes('hegrenade')) return he;
  if (name.includes('molotov')) return molotov;
  if (name.includes('inc')) return incendiary;
  if (name.includes('decoy')) return decoy;
  return undefined;
}
