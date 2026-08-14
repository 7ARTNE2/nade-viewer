export type ThrowKeyVisual = {
  glyph: string;
  label: string;
  kind: string;
  title: string;
  iconOnly: boolean;
};

export const splitThrowKeys = (value?: string | null) =>
  value
    ?.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 5) ?? [];

export const throwKeyVisual = (key: string): ThrowKeyVisual => {
  const clean = key.trim();
  const normalized = clean.toLowerCase().replace(/[\s_-]/g, '');
  const label = clean || 'Key';

  if (
    ['m1', 'mouse1', 'mouseleft', 'leftclick', 'lmb', 'attack'].includes(
      normalized,
    )
  ) {
    return {
      glyph: 'mouse-left',
      label,
      kind: 'mouse',
      title: clean,
      iconOnly: true,
    };
  }
  if (
    ['m2', 'mouse2', 'mouseright', 'rightclick', 'rmb', 'attack2'].includes(
      normalized,
    )
  ) {
    return {
      glyph: 'mouse-right',
      label,
      kind: 'mouse',
      title: clean,
      iconOnly: true,
    };
  }
  if (normalized.includes('jump'))
    return {
      glyph: 'jump',
      label,
      kind: 'jump',
      title: clean,
      iconOnly: false,
    };
  if (normalized === 'space')
    return {
      glyph: 'space',
      label,
      kind: 'key',
      title: clean,
      iconOnly: false,
    };
  if (normalized === 'w' || normalized === 'forward')
    return {
      glyph: 'move-up',
      label,
      kind: 'move',
      title: clean,
      iconOnly: false,
    };
  if (normalized === 'a' || normalized === 'left')
    return {
      glyph: 'move-left',
      label,
      kind: 'move',
      title: clean,
      iconOnly: false,
    };
  if (normalized === 's' || normalized === 'back')
    return {
      glyph: 'move-down',
      label,
      kind: 'move',
      title: clean,
      iconOnly: false,
    };
  if (normalized === 'd' || normalized === 'right')
    return {
      glyph: 'move-right',
      label,
      kind: 'move',
      title: clean,
      iconOnly: false,
    };
  if (
    normalized === 'ctrl' ||
    normalized === 'control' ||
    normalized.includes('duck') ||
    normalized.includes('crouch')
  ) {
    return {
      glyph: 'duck',
      label,
      kind: 'duck',
      title: clean,
      iconOnly: false,
    };
  }
  if (normalized === 'shift' || normalized.includes('walk'))
    return {
      glyph: 'walk',
      label,
      kind: 'walk',
      title: clean,
      iconOnly: false,
    };

  return {
    glyph: 'generic',
    label,
    kind: 'key',
    title: clean,
    iconOnly: false,
  };
};
