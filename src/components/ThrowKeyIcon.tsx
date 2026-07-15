type Props = {
  glyph: string;
};

export default function ThrowKeyIcon({ glyph }: Props) {
  if (glyph === "mouse-left" || glyph === "mouse-right") {
    const right = glyph === "mouse-right";
    return (
      <svg className="throw-key-svg" viewBox="0 0 20 24" aria-hidden="true">
        <path d="M10 1.5c-4.1 0-7 3.2-7 7.4v6.2c0 4.2 2.9 7.4 7 7.4s7-3.2 7-7.4V8.9c0-4.2-2.9-7.4-7-7.4Z" />
        <path d="M10 2v8M3.7 9.5h12.6" />
        <path className="throw-key-svg-fill" d={right ? "M10.8 2.7c3.2.4 5.3 2.9 5.3 6H10.8v-6Z" : "M9.2 2.7c-3.2.4-5.3 2.9-5.3 6h5.3v-6Z"} />
      </svg>
    );
  }

  if (glyph.startsWith("move-")) {
    const rotation: Record<string, number> = { "move-up": 0, "move-right": 90, "move-down": 180, "move-left": 270 };
    return (
      <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${rotation[glyph]}deg)` }}>
        <path d="m12 4 6.5 7H15v8H9v-8H5.5L12 4Z" />
      </svg>
    );
  }

  if (glyph === "jump") {
    return <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18h14M8 15l4-9 4 9M9.5 12h5" /></svg>;
  }

  if (glyph === "duck") {
    return <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6" r="2.5" /><path d="M7 17h10M9 10h6l2 4H7l2-4Zm3 4v5" /></svg>;
  }

  if (glyph === "walk") {
    return <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4.5" r="2" /><path d="m11 8-2 5 3 2 2 5m-3-7 5-2 2 3M9 13l-3 5" /></svg>;
  }

  if (glyph === "space") {
    return <svg className="throw-key-svg throw-key-svg-wide" viewBox="0 0 30 16" aria-hidden="true"><path d="M3 4v7h24V4M8 8h14" /></svg>;
  }

  return <svg className="throw-key-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 12h6M12 9v6" /></svg>;
}
