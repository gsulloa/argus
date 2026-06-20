/**
 * Shared TTL primitives for the per-engine schema/table caches.
 *
 * The schema/table trees cache their listings in a process-wide store so that
 * switching focus between connections in the Workspace rail serves the cached
 * tree instantly instead of re-fetching. Each cache entry records a `fetchedAt`
 * timestamp; once it is older than {@link SCHEMA_CACHE_TTL_MS} it is considered
 * stale and the next time the connection is viewed it is refreshed in the
 * background (the stale data keeps rendering until the refresh resolves).
 */

/** Time-to-live for a cached schema/table listing: 1 hour. */
export const SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * True when a cache entry stamped at `fetchedAt` is stale (older than `ttlMs`)
 * and should be refreshed. A missing timestamp is always considered stale.
 */
export function isStale(
  fetchedAt: number | undefined,
  ttlMs: number = SCHEMA_CACHE_TTL_MS,
): boolean {
  if (fetchedAt === undefined) return true;
  return Date.now() - fetchedAt >= ttlMs;
}
