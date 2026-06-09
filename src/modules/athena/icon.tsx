interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Athena mark — a layered lake-over-strata motif.
 *
 * Shape-category contract: horizontal stacked layers with a wavy
 * top surface (the lake/water), three horizontal bands beneath
 * (the rock/data strata). Distinguishable from the Postgres elephant
 * (vertical organic), MySQL dolphin (horizontal animal), DynamoDB
 * cylinders (vertical stack), and MSSQL at 14px by silhouette alone.
 * Hairline stroke (1.5) on a 24px viewBox, inherits currentColor.
 * No fills, no gradients — line-only.
 */
export function AthenaIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="Athena"
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
      {/* Wavy water surface — lake on top */}
      <path d="M3 8 C5 6.5, 7 9.5, 9 8 S13 6.5, 15 8 S19 9.5, 21 8" />
      {/* Stratum 1 — upper rock band */}
      <line x1="3" y1="12" x2="21" y2="12" />
      {/* Stratum 2 — middle rock band */}
      <line x1="3" y1="16" x2="21" y2="16" />
      {/* Stratum 3 — bottom rock band / base */}
      <line x1="3" y1="20" x2="21" y2="20" />
    </svg>
  );
}
