interface IconProps {
  size?: number;
  className?: string;
}

/**
 * CloudWatch Logs mark — a log-stream / eye motif.
 *
 * Shape-category contract: a scroll/log roll (horizontal lines suggesting
 * log entries) topped by a small eye arc (CloudWatch = the watcher of logs).
 * Distinguishable from Athena (wavy lake), DynamoDB (cylinder stack),
 * Postgres (elephant), MySQL (dolphin) at 14px by silhouette.
 * Hairline stroke (1.5) on a 24px viewBox, inherits currentColor.
 * No fills, no gradients — line-only per DESIGN.md.
 */
export function CloudwatchIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="CloudWatch Logs"
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
      {/* Eye arc — top half of an eye watching the logs */}
      <path d="M3 9 C6 5, 18 5, 21 9 C18 13, 6 13, 3 9 Z" />
      {/* Pupil dot — center of the eye */}
      <circle cx="12" cy="9" r="1.5" />
      {/* Log line 1 */}
      <line x1="5" y1="16" x2="19" y2="16" />
      {/* Log line 2 */}
      <line x1="5" y1="19" x2="15" y2="19" />
    </svg>
  );
}
