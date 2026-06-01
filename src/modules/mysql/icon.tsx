interface IconProps {
  size?: number;
  className?: string;
}

/**
 * MySQL mark — a dolphin silhouette in organic horizontal flow.
 *
 * Shape-category contract: rounded organic horizontal profile with a clearly
 * directional elongated beak/rostrum and a curved dorsal fin rising from the
 * back. Pairs against the Postgres elephant (vertical head+trunk) and the
 * DynamoDB stacked cylinders so that all three are distinguishable by silhouette
 * alone at 14px without color cues. Hairline stroke (1.5) on a 24px viewBox,
 * inherits currentColor.
 */
export function MysqlIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="MySQL"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Body: horizontal organic blob flowing left (head/beak) to right (tail) */}
      <path d="M3 12c0-3 2.5-5 6-5h4c2.5 0 5 1.5 6 4" />
      {/* Tail: forked fluke at the right end */}
      <path d="M19 11c1.5-1 3-1 3.5 1s-1 3-2.5 3" />
      <path d="M19 13c1.5 1 2.5 2.5 2 4s-2 1.5-3 0" />
      {/* Dorsal fin: triangular fin rising from the back mid-body */}
      <path d="M11 7c0-1.5 1.5-4 3-4s2 2 1 4" />
      {/* Belly: smooth lower arc closing the body */}
      <path d="M3 12c0 3 2.5 5 6 5h4c2.5 0 4.5-1.5 5.5-4" />
      {/* Eye: tiny filled circle near the beak */}
      <circle cx="6.5" cy="11.5" r="0.7" fill="currentColor" />
    </svg>
  );
}
