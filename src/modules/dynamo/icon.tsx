interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Minimal DynamoDB mark — a stylised partition-key motif: a vertical bisector
 * inside nested rounded rectangles, evoking hash-key + sort-key composite
 * structure without using AWS iconography.
 *
 * Sized and stroked to match the Lucide icon set's visual weight
 * (1.5px stroke, 16px default), consistent with the Postgres icon.
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
      {/* Outer rounded rectangle */}
      <rect x="4" y="5" width="16" height="14" rx="3" />
      {/* Vertical bisector — primary partition key */}
      <line x1="12" y1="5" x2="12" y2="19" />
      {/* Short inner hash marks — sort key indicators */}
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="16" y1="10" x2="16" y2="14" />
    </svg>
  );
}
