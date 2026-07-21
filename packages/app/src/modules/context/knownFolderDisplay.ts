import type { KnownFolderConnection } from "./types";

/**
 * Max number of referencing connections shown inline in a reuse-first
 * selector option before collapsing the rest into a "+N more" suffix.
 */
export const MAX_KNOWN_FOLDER_CONNECTIONS = 3;

/**
 * Human label for a canonical engine identifier (the `engine` subtree string
 * returned by `context_list_known_folders`). Unknown engines fall back to the
 * raw string so an unrecognized kind still renders something.
 */
const ENGINE_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mssql: "SQL Server",
  dynamo: "DynamoDB",
  athena: "Athena",
  cloudwatch: "CloudWatch",
};

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

/**
 * Build the "used by" summary for a known folder's referencing connections,
 * capped at {@link MAX_KNOWN_FOLDER_CONNECTIONS}. Returns `null` when the
 * folder has no referencing connections. `overflow` is the count hidden beyond
 * the cap (0 when all fit).
 */
export function knownFolderUsedBy(
  connections: KnownFolderConnection[] | undefined,
  cap: number = MAX_KNOWN_FOLDER_CONNECTIONS,
): { text: string; overflow: number } | null {
  if (!connections || connections.length === 0) return null;
  const shown = connections.slice(0, cap);
  const overflow = connections.length - shown.length;
  const text = shown
    .map((c) => `${c.name} · ${engineLabel(c.engine)}`)
    .join(", ");
  return { text, overflow };
}
