/**
 * JsonView — task 11.1–11.3
 *
 * Virtualized list of CodeMirror read-only JSON blocks, one per DynamoDB item.
 *
 * Architecture:
 *   - useVirtualizer (TanStack Virtual) drives scroll geometry.
 *   - mountedSet: indices that have a live EditorView instance.
 *     = visible virtualItems ± LOOK_AROUND window ∪ {selectedRowIndex}.
 *   - Unmounted slots render as a fixed-height <div> placeholder so scroll
 *     geometry stays correct and the virtualizer can accurately measure.
 *   - CodeMirror uses @codemirror/lang-json for JSON syntax highlighting
 *     and a minimal read-only theme matching DESIGN.md tokens.
 *   - Each block header shows "Item #i — pk=<value>, sk=<value>" (sk omitted
 *     when the active index has no sort key).
 *
 * Scroll-to-load:
 *   Mirrors TabView's IntersectionObserver sentinel pattern exactly — a
 *   dedicated sentinel <div> after the virtualizer body fires onLoadMore
 *   once the last block enters the viewport (deduped with a firedRef).
 *
 * PK/SK extraction:
 *   Resolves the active key schema from describe (primary or GSI/LSI) and
 *   picks the {S}/{N}/{B} string for display.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import type { AttributeMap, AttributeValue } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { DynamoItemsStatus } from "./useDynamoItems";
import styles from "./JsonView.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOK_AROUND = 5; // look-ahead / look-behind window
const ESTIMATED_BLOCK_HEIGHT = 240;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface JsonViewProps {
  items: AttributeMap[];
  selectedRowIndex: number | null;
  onSelect: (rowIndex: number) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  status: DynamoItemsStatus;
  autoScrollDisabled: boolean;
  describe: TableDescription | null;
  indexName: string | null;
}

// ---------------------------------------------------------------------------
// Helpers: key schema resolution and value display
// ---------------------------------------------------------------------------

interface ActiveKeySchema {
  pkName: string;
  skName: string | null;
}

function resolveActiveKeySchema(
  describe: TableDescription | null,
  indexName: string | null,
): ActiveKeySchema {
  if (!describe) return { pkName: "pk", skName: null };

  let keySchema = describe.key_schema;

  if (indexName !== null) {
    const gsi = describe.global_secondary_indexes.find(
      (g) => g.index_name === indexName,
    );
    const lsi = describe.local_secondary_indexes.find(
      (l) => l.index_name === indexName,
    );
    if (gsi) keySchema = gsi.key_schema;
    else if (lsi) keySchema = lsi.key_schema;
  }

  const pkDef = keySchema.find((k) => k.key_type === "HASH");
  const skDef = keySchema.find((k) => k.key_type === "RANGE");
  return {
    pkName: pkDef?.attribute_name ?? "pk",
    skName: skDef?.attribute_name ?? null,
  };
}

function attrValueToString(val: AttributeValue | undefined): string {
  if (!val) return "(missing)";
  if ("S" in val) return val.S;
  if ("N" in val) return val.N;
  if ("B" in val) return `<binary>`;
  if ("BOOL" in val) return String(val.BOOL);
  if ("NULL" in val) return "null";
  if ("L" in val) return `[${val.L.length} items]`;
  if ("M" in val) return `{${Object.keys(val.M).length} keys}`;
  if ("SS" in val) return `[${val.SS.length} items]`;
  if ("NS" in val) return `[${val.NS.length} items]`;
  if ("BS" in val) return `[${val.BS.length} items]`;
  return "(unknown)";
}

function buildHeader(
  item: AttributeMap,
  rowIndex: number,
  schema: ActiveKeySchema,
): string {
  const pkVal = attrValueToString(item[schema.pkName]);
  const pkPart = `pk=${pkVal}`;
  if (schema.skName !== null) {
    const skVal = attrValueToString(item[schema.skName]);
    return `Item #${rowIndex + 1} — ${pkPart}, sk=${skVal}`;
  }
  return `Item #${rowIndex + 1} — ${pkPart}`;
}

// ---------------------------------------------------------------------------
// JsonBlock — one item's block with a lazy-mounted CodeMirror editor
// ---------------------------------------------------------------------------

interface JsonBlockProps {
  item: AttributeMap;
  rowIndex: number;
  schema: ActiveKeySchema;
  selected: boolean;
  mounted: boolean;
  measureRef: (el: HTMLDivElement | null) => void;
  onSelect: (rowIndex: number) => void;
}

function JsonBlock({
  item,
  rowIndex,
  schema,
  selected,
  mounted,
  measureRef,
  onSelect,
}: JsonBlockProps) {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Sync the doc to the item whenever it changes.
  const jsonStr = useMemo(() => JSON.stringify(item, null, 2), [item]);

  // Mount / unmount the CodeMirror editor based on `mounted` prop.
  useEffect(() => {
    if (mounted) {
      if (viewRef.current) return; // already mounted
      const container = editorContainerRef.current;
      if (!container) return;

      const state = EditorState.create({
        doc: jsonStr,
        extensions: [
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          json(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.theme({
            "&": {
              fontSize: "12px",
              background: "transparent",
              fontFamily: "var(--font-mono)",
            },
            ".cm-content": {
              fontFamily: "var(--font-mono)",
              padding: "6px 0",
            },
            ".cm-gutters": { display: "none" },
            ".cm-line": { padding: "0 12px" },
            ".cm-focused": { outline: "none" },
            // No cursor, no selection highlight for read-only blocks.
            ".cm-selectionBackground": { display: "none" },
            "::selection": { background: "rgba(168,85,247,0.25)" },
          }),
          EditorView.lineWrapping,
        ],
      });

      const view = new EditorView({ state, parent: container });
      viewRef.current = view;
    } else {
      // Unmount
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Update doc when item changes (only when mounted).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== jsonStr) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: jsonStr },
      });
    }
  }, [jsonStr]);

  // Cleanup on unmount of the React component itself.
  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  const header = buildHeader(item, rowIndex, schema);

  return (
    <div
      ref={measureRef}
      className={`${styles.block} ${selected ? styles.blockSelected : ""}`}
      data-testid="json-block"
      data-row-index={rowIndex}
      onClick={() => onSelect(rowIndex)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(rowIndex);
      }}
      aria-selected={selected}
    >
      {/* Block header */}
      <div className={styles.blockHeader} data-testid="json-block-header">
        {header}
      </div>

      {/* CodeMirror container — always rendered so React can attach ref */}
      <div
        ref={editorContainerRef}
        className={styles.editorContainer}
        data-testid="json-block-editor"
        // Prevent click inside editor from propagating to block and re-selecting.
        onClick={(e) => e.stopPropagation()}
      />

      {/* Placeholder shown when not mounted (unmounted for performance) */}
      {!mounted && (
        <pre className={styles.unmountedPlaceholder} aria-hidden="true">
          {jsonStr.slice(0, 200)}
          {jsonStr.length > 200 ? "…" : ""}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JsonView
// ---------------------------------------------------------------------------

export function JsonView({
  items,
  selectedRowIndex,
  onSelect,
  onLoadMore,
  hasMore,
  status,
  autoScrollDisabled,
  describe,
  indexName,
}: JsonViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Resolve key schema once (memoized; describe rarely changes).
  const schema = useMemo(
    () => resolveActiveKeySchema(describe, indexName),
    [describe, indexName],
  );

  // ── Virtualizer ─────────────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    overscan: LOOK_AROUND,
    // Dynamic measurement: each block reports its rendered height.
    measureElement:
      typeof window !== "undefined"
        ? (el) => el?.getBoundingClientRect().height ?? ESTIMATED_BLOCK_HEIGHT
        : undefined,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // ── mountedSet: which indices actually have a live EditorView ──────────────
  // = union of visible ± LOOK_AROUND window and selectedRowIndex.
  const mountedSet = useMemo<ReadonlySet<number>>(() => {
    const set = new Set<number>();
    for (const vi of virtualItems) {
      const lo = Math.max(0, vi.index - LOOK_AROUND);
      const hi = Math.min(items.length - 1, vi.index + LOOK_AROUND);
      for (let i = lo; i <= hi; i++) set.add(i);
    }
    // The selected item's editor must always stay mounted.
    if (selectedRowIndex !== null) set.add(selectedRowIndex);
    return set;
  }, [virtualItems, selectedRowIndex, items.length]);

  // ── Scroll-to-load sentinel (mirrors TabView pattern) ─────────────────────
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
  }, [items.length, hasMore, autoScrollDisabled, status]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (!hasMore) return;
        if (autoScrollDisabled) return;
        if (status === "loading") return;
        if (firedRef.current) return;
        firedRef.current = true;
        onLoadMore();
      },
      { root: viewportRef.current, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, autoScrollDisabled, status, onLoadMore]);

  // ── measureRef factory ────────────────────────────────────────────────────
  const measureRef = useCallback(
    (_index: number) => (el: HTMLDivElement | null) => {
      if (el) virtualizer.measureElement(el);
    },
    [virtualizer],
  );

  // ── Empty / idle state ────────────────────────────────────────────────────
  if (items.length === 0 && status !== "loading") {
    const msg =
      status === "idle"
        ? "Run a query to see results."
        : status === "error"
          ? "Query returned an error."
          : "No items found.";
    return (
      <div className={styles.root}>
        <div className={styles.empty}>{msg}</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.viewport} ref={viewportRef}>
        {/* Virtualizer spacer — positions the absolute children correctly */}
        <div style={{ height: totalSize, width: "100%", position: "relative" }}>
          {virtualItems.map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const isMounted = mountedSet.has(vi.index);
            const isSelected = selectedRowIndex === vi.index;

            return (
              <div
                key={vi.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
                data-index={vi.index}
              >
                <JsonBlock
                  item={item}
                  rowIndex={vi.index}
                  schema={schema}
                  selected={isSelected}
                  mounted={isMounted}
                  measureRef={measureRef(vi.index)}
                  onSelect={onSelect}
                />
              </div>
            );
          })}
        </div>

        {/* Scroll-to-load sentinel */}
        <div
          ref={sentinelRef}
          style={{ height: 1, width: 1, flexShrink: 0 }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
