/**
 * Per-connection setting key for the AI context-payload size toggle.
 *
 * When `true`, the AI payload includes full Markdown bodies for every
 * documented object. When `false` (default), only `body_summary` is included.
 * Wired in Group 12.
 */
export const aiIncludeFullBodiesKey = (connectionId: string): string =>
  `context.aiIncludeFullBodies:${connectionId}`;
