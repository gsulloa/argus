interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Minimal Postgres mark — a stylised elephant silhouette sized to match the
 * Lucide icon set's visual weight (1.5px stroke, 16px default).
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
      <path d="M5 14c0-4 3-8 7-8 5 0 7 3 7 7 0 3-2 7-5 7-2 0-3-1-3-3 0-2 1-3 2-3" />
      <path d="M9 14c0-2 1-4 3-4" />
      <path d="M5 14c-1 1-1 3 0 4 1 1 3 1 3-1" />
      <circle cx="14" cy="10" r="0.6" fill="currentColor" />
    </svg>
  );
}
