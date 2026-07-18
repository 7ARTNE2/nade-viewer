type Props = {
  glyph: string;
};

export default function ThrowKeyIcon({ glyph }: Props) {
  if (glyph === 'mouse-left' || glyph === 'mouse-right') {
    const right = glyph === 'mouse-right';
    return (
      <svg className="throw-key-svg" viewBox="0 0 20 24" aria-hidden="true">
        <path d="M10 1.5c-4.1 0-7 3.2-7 7.4v6.2c0 4.2 2.9 7.4 7 7.4s7-3.2 7-7.4V8.9c0-4.2-2.9-7.4-7-7.4Z" />
        <path d="M10 2v8M3.7 9.5h12.6" />
        <path
          className="throw-key-svg-fill"
          d={
            right
              ? 'M10.8 2.7c3.2.4 5.3 2.9 5.3 6H10.8v-6Z'
              : 'M9.2 2.7c-3.2.4-5.3 2.9-5.3 6h5.3v-6Z'
          }
        />
      </svg>
    );
  }

  return (
    <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M7.5 7h9M7.5 10.5h9M7.5 14h5M14.5 14h2" />
    </svg>
  );
}
