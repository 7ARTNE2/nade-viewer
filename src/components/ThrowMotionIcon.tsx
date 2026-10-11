type Props = {
  kind: 'all' | 'moving' | 'stationary' | 'jumping' | 'grounded';
};

// A shared figure, stroke weight, and ground line keep the four poses related.
export default function ThrowMotionIcon({ kind }: Props) {
  return (
    <svg
      className="throw-motion-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'all' ? (
        <path d="M12 12C9.5 8.5 8 7 6 7a5 5 0 0 0 0 10c2 0 3.5-1.5 6-5s4-5 6-5a5 5 0 0 1 0 10c-2 0-3.5-1.5-6-5Z" />
      ) : kind === 'moving' ? (
        <>
          <path className="throw-motion-context" d="M2.5 9h3M1.5 13h3" />
          <circle cx="15" cy="4.5" r="2" fill="currentColor" stroke="none" />
          <path d="m12.5 8.5-3.5 2-1.5 3M12.5 8.5l3.5 3 3-1M12.5 8.5l-2 6 4 2.5 1 4M10.5 14.5l-3 4H4" />
        </>
      ) : kind === 'stationary' ? (
        <>
          <ellipse
            className="throw-motion-context"
            cx="12"
            cy="21.5"
            rx="6"
            ry="1.5"
          />
          <circle cx="12" cy="4" r="2" fill="currentColor" stroke="none" />
          <path d="M12 8v6M9 8.5h6M9 8.5l-1 5M15 8.5l1 5M12 14l-2 6M12 14l2 6" />
        </>
      ) : kind === 'jumping' ? (
        <>
          <path
            className="throw-motion-context"
            d="M6 22h12M3.5 16v-3M20.5 16v-3"
          />
          <circle cx="12" cy="4" r="2" fill="currentColor" stroke="none" />
          <path d="M12 8v5M12 8l-4 1-2-3M12 8l4 1 2-3M12 13l-4 3 2.5 2M12 13l4 3-2.5 2" />
        </>
      ) : (
        <>
          <path className="throw-motion-context" d="M5 22h14" />
          <circle cx="12" cy="4" r="2" fill="currentColor" stroke="none" />
          <path d="M12 8v6M9 8.5h6M9 8.5l-1 5M15 8.5l1 5M12 14l-2 6H8M12 14l2 6h2" />
        </>
      )}
    </svg>
  );
}
