interface IconProps {
  size?: number;
  className?: string;
}

/**
 * MS SQL Server mark — a server stack silhouette with a small flag pennant.
 *
 * Shape-category contract: three stacked rectangular server units (hairline
 * outlines) with horizontal vent lines on the top unit, plus a thin vertical
 * pole on the top-right corner with a small triangular flag/pennant attached.
 * Distinguishable at 14px from:
 *   - PostgresIcon (vertical elephant head + trunk silhouette)
 *   - MysqlIcon (horizontal dolphin organic flow)
 *   - DynamoIcon (stacked cylinders — oval tops/bottoms)
 *
 * Hairline strokes (1.5) on a 24px viewBox, inherits currentColor.
 */
export default function MssqlIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="MS SQL Server"
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
      {/* Top server unit */}
      <rect x="3" y="4" width="15" height="5" rx="1" />
      {/* Vent lines on top unit */}
      <line x1="5" y1="6" x2="8" y2="6" />
      <line x1="5" y1="7.5" x2="8" y2="7.5" />
      {/* Middle server unit */}
      <rect x="3" y="10" width="15" height="4" rx="1" />
      {/* Bottom server unit */}
      <rect x="3" y="15" width="15" height="4" rx="1" />
      {/* Flag pole — thin vertical line at top-right */}
      <line x1="20" y1="2" x2="20" y2="9" />
      {/* Flag pennant — small triangle pointing right off the pole */}
      <path d="M20 2 L23 4 L20 6Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export { MssqlIcon };
