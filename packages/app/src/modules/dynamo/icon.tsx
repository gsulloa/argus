interface IconProps {
  size?: number;
  className?: string;
}

/**
 * DynamoDB mark — a stacked-cylinder database glyph.
 *
 * Shape-category contract: horizontally-banded geometric stack (top lid +
 * three visible layers + side walls + bottom curve). Deliberately *unlike*
 * the Postgres organic blob so the two source-kind icons are distinguishable
 * at 14px by silhouette alone, with no color cues and no AWS iconography.
 * Hairline stroke (1.5) on a 24px viewBox, inherits currentColor.
 */
export function DynamoIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="DynamoDB"
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
      {/* Top lid — full top face of the cylinder */}
      <ellipse cx="12" cy="5" rx="8" ry="2" />
      {/* Side walls + bottom face */}
      <path d="M4 5v13a8 2 0 0 0 16 0V5" />
      {/* Internal disc separator 1 — upper band */}
      <path d="M4 9.5a8 2 0 0 0 16 0" />
      {/* Internal disc separator 2 — lower band */}
      <path d="M4 14a8 2 0 0 0 16 0" />
    </svg>
  );
}
