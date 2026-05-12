/**
 * TableLeaf — rendering helpers for a single DynamoDB table leaf in the sidebar subtree.
 *
 * Exports two components used by DynamoConnectionSubtree via SidebarTree render props:
 *   - TableLeafLabel: rendered via renderLabel — the highlighted table name. Also calls
 *     requestDescribe on mount so the cache pipeline fires for visible rows.
 *   - TableLeafBadge: rendered via renderBadge — shimmer while loading, badges once ready,
 *     inline retry on error.
 *
 * Keeping them separate lets SidebarTree own the flex layout (label = flex:1 with ellipsis,
 * badge = flex-shrink:0 to the right) without the badges getting clipped inside the label span.
 *
 * Badge layout (right of name):
 *   [billing-mode] [streams-icon] [GSI×N] [STATUS when non-ACTIVE]
 */

import { useEffect, type ReactNode } from "react";
import { Zap, RotateCw } from "lucide-react";
import type { DescribeSlot } from "./CacheProvider";
import styles from "./TableLeaf.module.css";

// ---------------------------------------------------------------------------
// Shared props
// ---------------------------------------------------------------------------

export interface TableLeafProps {
  tableName: string;
  describeSlot: DescribeSlot | undefined;
  searchQuery: string;
  requestDescribe: (tableName: string) => void;
  retryDescribe: (tableName: string) => void;
}

// ---------------------------------------------------------------------------
// Name highlight helper
// ---------------------------------------------------------------------------

function highlightName(label: string, query: string): ReactNode {
  if (!query) return label;
  const idx = label.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <mark className={styles.match}>{label.slice(idx, idx + query.length)}</mark>
      {label.slice(idx + query.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// TableLeafLabel — rendered via SidebarTree's renderLabel prop.
// Calls requestDescribe on mount to drive the lazy describe pipeline.
// ---------------------------------------------------------------------------

export function TableLeafLabel({
  tableName,
  searchQuery,
  requestDescribe,
}: Pick<TableLeafProps, "tableName" | "searchQuery" | "requestDescribe">): ReactNode {
  // Request describe on mount — idempotent in the cache (no-op if already
  // cached, loading, or in queue). This is the describe pipeline trigger:
  // SidebarTree virtualizes above 500 rows, so only mounted/visible leaf rows
  // fire this effect, giving viewport-driven describe for free.
  useEffect(() => {
    requestDescribe(tableName);
    // tableName is stable for the lifetime of this leaf (nodes are keyed by name).
    // requestDescribe is stable (useCallback in CacheProvider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName]);

  return <>{highlightName(tableName, searchQuery)}</>;
}

// ---------------------------------------------------------------------------
// TableLeafBadge — rendered via SidebarTree's renderBadge prop.
// ---------------------------------------------------------------------------

export function TableLeafBadge({
  tableName,
  describeSlot,
  retryDescribe,
}: Pick<TableLeafProps, "tableName" | "describeSlot" | "retryDescribe">): ReactNode {
  // Not yet requested or loading — show fixed-width shimmer placeholder
  if (!describeSlot || describeSlot.status === "loading") {
    return <span className={styles.shimmer} aria-hidden />;
  }

  // Error — show inline retry
  if (describeSlot.status === "error") {
    const msg = describeSlot.error.message ?? "Describe failed";
    return (
      <button
        type="button"
        className={styles.retryBtn}
        title={msg}
        aria-label={`Retry describe for ${tableName}: ${msg}`}
        onClick={(e) => {
          e.stopPropagation();
          retryDescribe(tableName);
        }}
      >
        <RotateCw size={11} />
      </button>
    );
  }

  // Ready — render badges
  const desc = describeSlot.value;
  const billingLabel = desc.billing_mode === "PAY_PER_REQUEST" ? "on-demand" : "provisioned";
  const hasStreams =
    desc.stream_specification != null && desc.stream_specification.stream_enabled;
  const streamViewType = desc.stream_specification?.stream_view_type;
  const gsiCount = desc.global_secondary_indexes.length;
  const isNonActive = desc.table_status !== "ACTIVE";

  return (
    <span className={styles.badges}>
      <span className={styles.badge}>{billingLabel}</span>
      {hasStreams && (
        <span
          className={styles.streamBadge}
          title={
            streamViewType
              ? `Streams enabled · ${streamViewType}`
              : "Streams enabled"
          }
          aria-label={
            streamViewType
              ? `Streams enabled · ${streamViewType}`
              : "Streams enabled"
          }
        >
          <Zap size={10} />
        </span>
      )}
      {gsiCount > 0 && (
        <span className={styles.badge}>{`GSI×${gsiCount}`}</span>
      )}
      {isNonActive && (
        <span className={`${styles.badge} ${styles.badgeWarning}`}>
          {desc.table_status}
        </span>
      )}
    </span>
  );
}
