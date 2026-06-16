/**
 * Inspector — task 12.1–12.4
 *
 * Renders the selected DynamoDB item as an attribute tree with type badges.
 *
 * Architecture:
 *   - Top-level: iterates over the item's attribute entries.
 *   - Each attribute renders `name : <typeBadge> : value`.
 *   - Nested L (List) and M (Map): chevron-disclosure; expand on click.
 *   - Sets (SS, NS, BS): render element-per-row in a read-only list when expanded.
 *   - PK / SK rows get an accent treatment per DESIGN.md.
 *   - Empty state ("Select a row to inspect") when selectedItem is null.
 *   - Escape clears selection when focus is not inside a CodeMirror or text input.
 *     Guard order: check focusIsInCodeMirror() first (same guard used in DataViewTab
 *     for ⌘R / ⌘⇧R), then check isTypingTarget (standard input fields). Only if
 *     both pass do we fire clearSelection. Mirrors Phase 5's shortcut precedence.
 *
 * Resizable width:
 *   Delegated to the parent (DataViewTab) which owns useDynamoInspectorWidth and
 *   the drag handle. The Inspector itself is a pure display component and does not
 *   manage its own width.
 *
 * Type badges:
 *   S | N | B | BOOL | NULL | L | M | SS | NS | BS
 *   Rendered as small monospace chips, color-neutral except PK/SK which get
 *   the accent background.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AttributeMap, AttributeValue } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { useContextObject } from "@/modules/context/hooks";
import { DocsPanel } from "@/modules/context/components/DocsPanel";
import { InspectorJsonEditor } from "./edit/InspectorJsonEditor";
import styles from "./Inspector.module.css";

// ---------------------------------------------------------------------------
// Helpers: key schema resolution
// ---------------------------------------------------------------------------

interface KeyNames {
  pkName: string | null;
  skName: string | null;
}

function resolveKeyNames(
  describe: TableDescription | null,
  indexName: string | null,
): KeyNames {
  if (!describe) return { pkName: null, skName: null };

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
    pkName: pkDef?.attribute_name ?? null,
    skName: skDef?.attribute_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type AttrTag = "S" | "N" | "B" | "BOOL" | "NULL" | "L" | "M" | "SS" | "NS" | "BS";

function getTag(val: AttributeValue): AttrTag {
  if ("S" in val) return "S";
  if ("N" in val) return "N";
  if ("B" in val) return "B";
  if ("BOOL" in val) return "BOOL";
  if ("NULL" in val) return "NULL";
  if ("L" in val) return "L";
  if ("M" in val) return "M";
  if ("SS" in val) return "SS";
  if ("NS" in val) return "NS";
  if ("BS" in val) return "BS";
  return "S"; // fallback
}

function primitiveDisplay(val: AttributeValue): string | null {
  if ("S" in val) return `"${val.S}"`;
  if ("N" in val) return val.N;
  if ("BOOL" in val) return String(val.BOOL);
  if ("NULL" in val) return "null";
  return null;
}

// ---------------------------------------------------------------------------
// TypeBadge
// ---------------------------------------------------------------------------

function TypeBadge({
  tag,
  isPk,
  isSk,
}: {
  tag: AttrTag;
  isPk: boolean;
  isSk: boolean;
}) {
  const accent = isPk || isSk;
  return (
    <span
      className={`${styles.badge} ${accent ? styles.badgeAccent : ""}`}
      title={
        isPk
          ? "Partition Key"
          : isSk
            ? "Sort Key"
            : `DynamoDB type: ${tag}`
      }
    >
      {tag}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AttributeNode — recursive tree node
// ---------------------------------------------------------------------------

interface AttributeNodeProps {
  name: string;
  value: AttributeValue;
  depth: number;
  isPk: boolean;
  isSk: boolean;
}

function AttributeNode({ name, value, depth, isPk, isSk }: AttributeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const tag = getTag(value);
  const primitive = primitiveDisplay(value);
  const indent = depth * 16;

  const toggleExpand = useCallback(() => setExpanded((p) => !p), []);

  // ── Nested Map ─────────────────────────────────────────────────────────────
  if ("M" in value) {
    const keys = Object.keys(value.M);
    return (
      <div className={styles.node} style={{ paddingLeft: indent }}>
        <div
          className={`${styles.row} ${isPk ? styles.rowPk : isSk ? styles.rowSk : ""}`}
          data-testid="inspector-row"
          data-key={isPk ? "pk" : isSk ? "sk" : undefined}
        >
          <button
            type="button"
            className={styles.expandBtn}
            onClick={toggleExpand}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight
              size={10}
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            />
          </button>
          <span className={styles.attrName}>{name}</span>
          <TypeBadge tag="M" isPk={isPk} isSk={isSk} />
          <span className={styles.attrSummary}>
            {`{${keys.length} key${keys.length !== 1 ? "s" : ""}}`}
          </span>
        </div>
        {expanded &&
          keys.map((k) => (
            <AttributeNode
              key={k}
              name={k}
              value={value.M[k]!}
              depth={depth + 1}
              isPk={false}
              isSk={false}
            />
          ))}
      </div>
    );
  }

  // ── Nested List ────────────────────────────────────────────────────────────
  if ("L" in value) {
    return (
      <div className={styles.node} style={{ paddingLeft: indent }}>
        <div
          className={`${styles.row} ${isPk ? styles.rowPk : isSk ? styles.rowSk : ""}`}
          data-testid="inspector-row"
          data-key={isPk ? "pk" : isSk ? "sk" : undefined}
        >
          <button
            type="button"
            className={styles.expandBtn}
            onClick={toggleExpand}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight
              size={10}
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            />
          </button>
          <span className={styles.attrName}>{name}</span>
          <TypeBadge tag="L" isPk={isPk} isSk={isSk} />
          <span className={styles.attrSummary}>
            {`[${value.L.length} item${value.L.length !== 1 ? "s" : ""}]`}
          </span>
        </div>
        {expanded &&
          value.L.map((item, i) => (
            <AttributeNode
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              name={`[${i}]`}
              value={item}
              depth={depth + 1}
              isPk={false}
              isSk={false}
            />
          ))}
      </div>
    );
  }

  // ── Sets: SS, NS, BS ──────────────────────────────────────────────────────
  if ("SS" in value || "NS" in value || "BS" in value) {
    const setTag: AttrTag = "SS" in value ? "SS" : "NS" in value ? "NS" : "BS";
    const elements: string[] =
      "SS" in value ? value.SS : "NS" in value ? value.NS : value.BS;

    return (
      <div className={styles.node} style={{ paddingLeft: indent }}>
        <div
          className={`${styles.row} ${isPk ? styles.rowPk : isSk ? styles.rowSk : ""}`}
          data-testid="inspector-row"
          data-key={isPk ? "pk" : isSk ? "sk" : undefined}
        >
          <button
            type="button"
            className={styles.expandBtn}
            onClick={toggleExpand}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight
              size={10}
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            />
          </button>
          <span className={styles.attrName}>{name}</span>
          <TypeBadge tag={setTag} isPk={isPk} isSk={isSk} />
          <span className={styles.attrSummary}>
            {`[${elements.length} item${elements.length !== 1 ? "s" : ""}]`}
          </span>
        </div>
        {expanded && (
          <div className={styles.setElements} style={{ paddingLeft: indent + 16 }}>
            {elements.map((el, i) => (
              <div
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                className={styles.setElement}
                data-testid="inspector-set-element"
              >
                <code className={styles.setValue}>{el}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Binary ─────────────────────────────────────────────────────────────────
  if ("B" in value) {
    const byteLen = Math.floor(value.B.length * 0.75);
    return (
      <div className={styles.node} style={{ paddingLeft: indent }}>
        <div
          className={`${styles.row} ${isPk ? styles.rowPk : isSk ? styles.rowSk : ""}`}
          data-testid="inspector-row"
          data-key={isPk ? "pk" : isSk ? "sk" : undefined}
        >
          <span className={styles.expandPlaceholder} />
          <span className={styles.attrName}>{name}</span>
          <TypeBadge tag="B" isPk={isPk} isSk={isSk} />
          <code className={styles.attrValue}>
            {`<binary ${byteLen}B>`}
          </code>
        </div>
      </div>
    );
  }

  // ── Primitives: S, N, BOOL, NULL ──────────────────────────────────────────
  return (
    <div className={styles.node} style={{ paddingLeft: indent }}>
      <div
        className={`${styles.row} ${isPk ? styles.rowPk : isSk ? styles.rowSk : ""}`}
        data-testid="inspector-row"
        data-key={isPk ? "pk" : isSk ? "sk" : undefined}
      >
        <span className={styles.expandPlaceholder} />
        <span className={styles.attrName}>{name}</span>
        <TypeBadge tag={tag} isPk={isPk} isSk={isSk} />
        <code
          className={`${styles.attrValue} ${
            tag === "BOOL"
              ? primitive === "true"
                ? styles.boolTrue
                : styles.boolFalse
              : tag === "NULL"
                ? styles.nullValue
                : ""
          }`}
        >
          {primitive}
        </code>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector — public component
// ---------------------------------------------------------------------------

export interface LockingConfig {
  versionAttr: string;
  enabled: boolean;
  pkAttr: string;
}

export interface InspectorProps {
  item: AttributeMap | null;
  describe: TableDescription | null;
  indexName: string | null;
  onClearSelection: () => void;
  /** When true the "Edit item" button is hidden. */
  isReadOnly?: boolean;
  /** Connection id — forwarded to InspectorJsonEditor for API calls. */
  connectionId?: string;
  /** Table name — forwarded to InspectorJsonEditor. */
  tableName?: string;
  /** Row index in the items list — forwarded to InspectorJsonEditor. */
  rowIndex?: number;
  /** Called with updated item on successful Save. */
  onPatchItem?: (rowIndex: number, next: AttributeMap) => void;
  /** Optional: notified when editing state changes (for §11 unsaved-draft). */
  onEditingChange?: (editing: boolean) => void;
  /** Optional: notified when the JSON editor's draft is dirty (task 11.1). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Optimistic locking config — forwarded to InspectorJsonEditor (task 10.5). */
  locking?: LockingConfig;
  /**
   * Context folder path — when provided, the Inspector fetches the table's
   * doc (§9.5 DocsPanel) and column notes (§9.6 attribute-definition notes).
   */
  contextPath?: string | null;
}

export function Inspector({
  item,
  describe,
  indexName,
  onClearSelection,
  isReadOnly = false,
  connectionId,
  tableName,
  rowIndex,
  onPatchItem,
  onEditingChange,
  onDirtyChange,
  locking,
  contextPath,
}: InspectorProps) {
  // ── Context-folder doc — §9.5/§9.6 ────────────────────────────────────────
  // Fetch the table's context doc to get column_notes for attribute decoration.
  // The DocsPanel also calls useContextObject; hooks run independently (no
  // React Query dedup in this codebase), but the extra call is cheap (cached
  // by the Tauri backend) and avoids prop-drilling the doc through DocsPanel.
  const { data: contextDoc } = useContextObject(
    connectionId ?? "",
    tableName ?? null,
    contextPath ?? null,
  );
  const keyNames = resolveKeyNames(describe, indexName);

  // ── Editing state — task 7.1 ───────────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);

  // When the item changes (e.g. user selects a different row), exit editing mode.
  const prevItemRef = useRef<AttributeMap | null>(null);
  useEffect(() => {
    if (item !== prevItemRef.current) {
      prevItemRef.current = item;
      if (isEditing) {
        setIsEditing(false);
        onEditingChange?.(false);
      }
    }
  });

  const enterEditing = useCallback(() => {
    setIsEditing(true);
    onEditingChange?.(true);
  }, [onEditingChange]);

  const exitEditing = useCallback(() => {
    setIsEditing(false);
    onEditingChange?.(false);
    // Clear dirty state when the editor is closed.
    onDirtyChange?.(false);
  }, [onEditingChange, onDirtyChange]);

  // ── Escape handler — task 12.4 ─────────────────────────────────────────────
  // Precedence mirrors Phase 5's shortcut guard:
  //   1. Don't fire if focus is inside CodeMirror (.cm-editor).
  //   2. Don't fire if focus is inside a native text input/textarea/select/[contenteditable].
  //   3. Otherwise clear the selection (or exit editing if in editor mode).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (!item) return; // nothing to clear

      // Guard: CodeMirror — let CodeMirror handle its own Escape (close editor via cancel btn)
      const active = document.activeElement;
      if (active?.closest(".cm-editor")) {
        // When in editor mode, Escape cancels editing
        if (isEditing) {
          e.preventDefault();
          exitEditing();
        }
        return;
      }

      // Guard: native text inputs
      const tag = (active as HTMLElement | null)?.tagName?.toLowerCase() ?? "";
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }

      e.preventDefault();
      if (isEditing) {
        exitEditing();
      } else {
        onClearSelection();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClearSelection, isEditing, exitEditing]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!item) {
    return (
      <div className={styles.empty} data-testid="inspector-empty">
        <span className={styles.emptyText}>Select a row to inspect</span>
      </div>
    );
  }

  // ── Resolved key names as an array for InspectorJsonEditor ────────────────
  const resolvedKeyNames: string[] = [
    keyNames.pkName,
    keyNames.skName,
  ].filter((n): n is string => n !== null);

  // ── Editor mode ─────────────────────────────────────────────────────────────
  if (isEditing && connectionId && tableName && rowIndex !== undefined && onPatchItem) {
    return (
      <div className={styles.root} data-testid="inspector-root">
        <div className={styles.header}>
          <span className={styles.headerTitle}>Edit item</span>
          <button
            type="button"
            data-testid="inspector-back-btn"
            onClick={exitEditing}
            style={{
              padding: "2px 8px",
              fontSize: 11,
              fontFamily: "inherit",
              background: "transparent",
              border: "1px solid var(--border-strong, #2e2f3a)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
        </div>
        <div style={{ flex: 1, padding: "8px 12px", minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <InspectorJsonEditor
            item={item}
            keyNames={resolvedKeyNames}
            connectionId={connectionId}
            tableName={tableName}
            rowIndex={rowIndex}
            onClose={exitEditing}
            onPatchItem={onPatchItem}
            onDirtyChange={onDirtyChange}
            locking={locking}
          />
        </div>
      </div>
    );
  }

  // ── Item tree ──────────────────────────────────────────────────────────────
  const entries = Object.entries(item);
  // Sort: PK first, SK second, rest alphabetical.
  const sorted = entries.sort(([a], [b]) => {
    const aPk = a === keyNames.pkName;
    const bPk = b === keyNames.pkName;
    const aSk = a === keyNames.skName;
    const bSk = b === keyNames.skName;

    if (aPk && !bPk) return -1;
    if (!aPk && bPk) return 1;
    if (aSk && !bSk) return -1;
    if (!aSk && bSk) return 1;
    return a.localeCompare(b);
  });

  // Column notes from context doc — §9.6
  const columnNotes = contextDoc?.human?.column_notes ?? null;

  return (
    <div className={styles.root} data-testid="inspector-root">
      <div className={styles.header}>
        <span className={styles.headerTitle}>Inspector</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={styles.headerCount}>
            {entries.length} attribute{entries.length !== 1 ? "s" : ""}
          </span>
          {/* Edit item button — task 7.1: hidden on read-only */}
          {!isReadOnly && connectionId && tableName && rowIndex !== undefined && onPatchItem && (
            <button
              type="button"
              data-testid="inspector-edit-btn"
              onClick={enterEditing}
              style={{
                padding: "2px 8px",
                fontSize: 11,
                fontFamily: "inherit",
                background: "transparent",
                border: "1px solid var(--border-strong, #2e2f3a)",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              Edit item
            </button>
          )}
        </div>
      </div>
      <div className={styles.tree}>
        {sorted.map(([attrName, attrValue]) => {
          const note = columnNotes?.[attrName] ?? null;
          return (
            <div key={attrName}>
              <AttributeNode
                name={attrName}
                value={attrValue}
                depth={0}
                isPk={attrName === keyNames.pkName}
                isSk={attrName === keyNames.skName}
              />
              {note && (
                <div
                  className={styles.attrNote}
                  data-testid="inspector-attr-note"
                  title={note}
                >
                  {note}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* §9.5 — DocsPanel: collapsible table docs below the attribute list */}
      {connectionId && tableName && contextPath && (
        <DocsPanel
          connectionId={connectionId}
          contextPath={contextPath}
          identity={tableName}
        />
      )}
    </div>
  );
}
