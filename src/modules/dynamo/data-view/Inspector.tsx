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

import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AttributeMap, AttributeValue } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
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

export interface InspectorProps {
  item: AttributeMap | null;
  describe: TableDescription | null;
  indexName: string | null;
  onClearSelection: () => void;
}

export function Inspector({
  item,
  describe,
  indexName,
  onClearSelection,
}: InspectorProps) {
  const keyNames = resolveKeyNames(describe, indexName);

  // ── Escape handler — task 12.4 ─────────────────────────────────────────────
  // Precedence mirrors Phase 5's shortcut guard:
  //   1. Don't fire if focus is inside CodeMirror (.cm-editor).
  //   2. Don't fire if focus is inside a native text input/textarea/select/[contenteditable].
  //   3. Otherwise clear the selection.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (!item) return; // nothing to clear

      // Guard: CodeMirror
      const active = document.activeElement;
      if (active?.closest(".cm-editor")) return;

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
      onClearSelection();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClearSelection]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!item) {
    return (
      <div className={styles.empty} data-testid="inspector-empty">
        <span className={styles.emptyText}>Select a row to inspect</span>
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

  return (
    <div className={styles.root} data-testid="inspector-root">
      <div className={styles.header}>
        <span className={styles.headerTitle}>Inspector</span>
        <span className={styles.headerCount}>
          {entries.length} attribute{entries.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className={styles.tree}>
        {sorted.map(([attrName, attrValue]) => (
          <AttributeNode
            key={attrName}
            name={attrName}
            value={attrValue}
            depth={0}
            isPk={attrName === keyNames.pkName}
            isSk={attrName === keyNames.skName}
          />
        ))}
      </div>
    </div>
  );
}
