import smokeIcon from "../assets/grenades_icons/smokegrenade.svg?raw";
import flashIcon from "../assets/grenades_icons/flashbang.svg?raw";
import molotovIcon from "../assets/grenades_icons/molotov.svg?raw";
import heIcon from "../assets/grenades_icons/hegrenade.svg?raw";

type Props = {
  grenadeType: string;
};

const icons: Record<string, string> = {
  smoke: smokeIcon,
  flash: flashIcon,
  molotov: molotovIcon,
  HE: heIcon,
};

export default function GrenadeMapIcon({ grenadeType }: Props) {
  const icon = icons[grenadeType];
  return icon ? <i className="grenade-map-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} /> : null;
}
