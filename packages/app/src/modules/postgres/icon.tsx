interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Postgres mark — an elephant head-and-trunk profile.
 *
 * Shape-category contract: organic rounded blob with a clearly directional
 * curving trunk. Pairs against the DynamoDB stacked-cylinder mark so the two
 * source-kind icons are distinguishable at 14px by silhouette alone, with no
 * color cues. Hairline stroke (1.5) on a 24px viewBox, inherits currentColor.
 */
export function PostgresIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="Postgres"
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
      {/* Head: rounded organic blob, symmetric around x=12, occupying the upper frame */}
      <path d="M12 4c-4 0-8 3-8 7v2c0 3 2 5 5 5h6c3 0 5-2 5-5v-2c0-4-4-7-8-7z" />
      {/* Trunk: sweeps down from the front of the head with an upward tip flick */}
      <path d="M5 13c-2 2-2 5 0 7 2 1 3 0 4-1" />
      {/* Eye */}
      <circle cx="13" cy="10" r="0.7" fill="currentColor" />
    </svg>
  );
}
