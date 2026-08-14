type Props = {
  glyph: string;
};

export default function ThrowKeyIcon({ glyph }: Props) {
  if (glyph === 'mouse-left' || glyph === 'mouse-right') {
    const isRightClick = glyph === 'mouse-right';
    return (
      <svg className="throw-mouse-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          className="throw-mouse-active"
          d={
            isRightClick
              ? 'M12 3h1.5A6.5 6.5 0 0 1 20 9.5V10h-8Z'
              : 'M10.5 3H12v7H4v-.5A6.5 6.5 0 0 1 10.5 3Z'
          }
        />
        <path d="M12 3v7M4 10h16M12 3h1.5A6.5 6.5 0 0 1 20 9.5v5a6.5 6.5 0 0 1-6.5 6.5h-3A6.5 6.5 0 0 1 4 14.5v-5A6.5 6.5 0 0 1 10.5 3Z" />
      </svg>
    );
  }

  return (
    <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M7.5 7h9M7.5 10.5h9M14.5 14h2" />
    </svg>
  );
}
