/**
 * Placeholder components for Phases 6–8.
 *
 * Phase 6 replaces QueryBuilderPlaceholder with the real QueryBuilder.
 * Phase 7 replaces ResultsPanelPlaceholder with the real Tabla/JSON views.
 * Phase 8 replaces InspectorPlaceholder with the real Inspector dock.
 *
 * Props are threaded through now so the replacement agents pick up the
 * same contract without re-architecting.
 */

import type { BuilderState } from "./types";
import type { AttributeMap } from "./types";
import type { DynamoItemsStatus } from "./useDynamoItems";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// QueryBuilderPlaceholder
// ---------------------------------------------------------------------------

export interface QueryBuilderPlaceholderProps {
  builder: BuilderState;
  describe: TableDescription;
  onBuilderChange(next: BuilderState): void;
}

export function QueryBuilderPlaceholder(_props: QueryBuilderPlaceholderProps) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-subtle)",
        flexShrink: 0,
      }}
    >
      Query builder — Phase 6
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultsPanelPlaceholder
// ---------------------------------------------------------------------------

export interface ResultsPanelPlaceholderProps {
  items: AttributeMap[];
  status: DynamoItemsStatus;
  error?: { message: string; code?: string };
  triggerAutoLoadMore(): void;
  onSelectItem?(item: AttributeMap, index: number): void;
}

export function ResultsPanelPlaceholder({ items, status }: ResultsPanelPlaceholderProps) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        color: "var(--text-subtle)",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span>Results panel — Phase 7</span>
      {status !== "idle" && (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {items.length} items loaded · status: {status}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InspectorPlaceholder
// ---------------------------------------------------------------------------

export interface InspectorPlaceholderProps {
  item: AttributeMap | null;
  describe: TableDescription | null;
  width: number;
}

export function InspectorPlaceholder({ item, width }: InspectorPlaceholderProps) {
  return (
    <div
      style={{
        width,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        color: "var(--text-subtle)",
        padding: "8px",
      }}
    >
      {item ? "Inspector — Phase 8" : "No selection"}
    </div>
  );
}
