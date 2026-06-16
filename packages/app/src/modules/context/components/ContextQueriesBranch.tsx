import { useState } from "react";
import { ChevronRight, Code2 } from "lucide-react";
import { useContextQueries } from "@/modules/context/hooks";
import type { QueryListItem } from "@/modules/context/types";
import styles from "./ContextQueriesBranch.module.css";

export interface ContextQueriesBranchProps {
  connectionId: string;
  connectionName: string;
  contextPath: string | null;
  engine: "postgres" | "mysql" | "mssql" | "dynamo" | "cloudwatch";
  /** Called when the user activates a query. */
  onActivate: (query: QueryListItem) => void;
}

/**
 * Sidebar branch that renders the list of context-folder prefab queries
 * under a connection node. Only wired for Postgres in v1; the component
 * accepts an `engine` prop so future engines replicate mechanically.
 *
 * Hidden when:
 *  - `contextPath` is null (no linked folder), OR
 *  - the loaded list is empty AND not loading AND no error.
 */
export function ContextQueriesBranch({
  connectionId,
  contextPath,
  onActivate,
}: ContextQueriesBranchProps): JSX.Element | null {
  const { data: queries, loading, error } = useContextQueries(connectionId, contextPath);

  // Default: expanded when ≤ 8 queries, collapsed otherwise.
  const [expanded, setExpanded] = useState<boolean | null>(null);

  // Resolve effective expansion: if user hasn't toggled, use the default rule.
  const effectiveExpanded =
    expanded !== null ? expanded : queries.length <= 8;

  // Guard 1: no linked folder.
  if (!contextPath) return null;

  // Guard 2: empty list (and not loading, and no error) — hide the branch.
  if (!loading && !error && queries.length === 0) return null;

  const sorted = [...queries].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded(!effectiveExpanded)}
        aria-expanded={effectiveExpanded}
      >
        <span className={styles.caret} data-expanded={String(effectiveExpanded)}>
          <ChevronRight size={11} strokeWidth={2} />
        </span>
        <span className={styles.label}>Context Queries</span>
        {queries.length > 0 && (
          <span className={styles.count}>{queries.length}</span>
        )}
      </button>

      {effectiveExpanded && (
        <div className={styles.body}>
          {loading && queries.length === 0 && (
            <div className={styles.skeleton}>
              <div className={styles.skeletonLine} style={{ width: "70%" }} />
              <div className={styles.skeletonLine} style={{ width: "55%" }} />
            </div>
          )}
          {error && (
            <div className={styles.error}>{error.message}</div>
          )}
          {sorted.map((query) => (
            <button
              key={query.name}
              type="button"
              className={styles.queryRow}
              title={query.description ?? query.name}
              onClick={() => onActivate(query)}
            >
              <span className={styles.queryIcon}>
                <Code2 size={12} strokeWidth={1.5} />
              </span>
              <span className={styles.queryName}>{query.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
