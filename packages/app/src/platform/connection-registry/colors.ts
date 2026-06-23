/**
 * Connection color palette — shared definitions for the connection-colors feature.
 *
 * The palette is a fixed, curated set of lowercase keys. Each key maps to a
 * CSS custom property (`--conn-color-<key>`) defined per theme in global.css,
 * so the same stored key renders a theme-appropriate shade under both dark and
 * light themes. Free-form / custom hex values are not accepted; the backend
 * validates against this exact key list.
 *
 * See: openspec/changes/connection-colors/specs/connection-colors/spec.md
 * See: openspec/changes/connection-colors/design.md (Decision 1, Decision 6)
 */

/** The ordered, fixed set of connection color keys. */
export type ConnectionColor =
  | "violet"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "teal"
  | "pink"
  | "gray";

/**
 * Ordered array of all valid connection color keys.
 * Use this when iterating the palette (e.g. rendering the picker).
 */
export const CONNECTION_COLOR_KEYS: ConnectionColor[] = [
  "violet",
  "blue",
  "green",
  "amber",
  "red",
  "teal",
  "pink",
  "gray",
];

/**
 * Ordered array of palette entries with human-readable display labels.
 * Consumed by the color picker component and any UI that needs to present
 * the palette to the user.
 */
export const CONNECTION_COLORS: { key: ConnectionColor; label: string }[] = [
  { key: "violet", label: "Violet" },
  { key: "blue", label: "Blue" },
  { key: "green", label: "Green" },
  { key: "amber", label: "Amber" },
  { key: "red", label: "Red" },
  { key: "teal", label: "Teal" },
  { key: "pink", label: "Pink" },
  { key: "gray", label: "Gray" },
];

/**
 * Returns the CSS `var()` reference for a given connection color key.
 * The variable is defined in both the light and dark theme blocks in
 * `src/styles/global.css`.
 *
 * @example
 *   connectionColorVar("amber") // → "var(--conn-color-amber)"
 */
export function connectionColorVar(key: ConnectionColor): string {
  return `var(--conn-color-${key})`;
}

/**
 * Type guard — returns true when `value` is a valid `ConnectionColor` key.
 * Use this to safely narrow `string | null | undefined` (e.g. when reading
 * `connection.color` before passing it to `connectionColorVar`).
 *
 * @example
 *   if (isConnectionColor(conn.color)) {
 *     style.color = connectionColorVar(conn.color);
 *   }
 */
export function isConnectionColor(
  value: string | null | undefined
): value is ConnectionColor {
  if (value == null) return false;
  return (CONNECTION_COLOR_KEYS as string[]).includes(value);
}
