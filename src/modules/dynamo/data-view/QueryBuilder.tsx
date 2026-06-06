/**
 * QueryBuilder — structured, DSL-less DynamoDB query builder.
 *
 * Controlled component: receives BuilderState and emits the next state via
 * onBuilderChange. All mutation is pure (no local builder state).
 *
 * Validity is communicated upward via onValidityChange(isValid, reason?).
 * DataViewTab routes this to Toolbar to disable the Run button when the
 * builder is in an invalid state (e.g., Query mode with no PK value).
 */

import React, { useMemo, useState, useRef, useImperativeHandle } from "react";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { compile } from "./builderCompiler";
import { compileModel } from "./modelCompiler";
import type { BuilderState, DynamoModel, FilterRow, TypedValue } from "./types";
import { getFilterCombinator } from "./types";
import {
  FilterBarShell,
  FilterBarHeader,
  FilterBarBody,
  FilterBarActions,
  FilterTypeBadge,
  FilterConnector,
  FilterRowAddButton,
  FilterKeyHint,
  PrimaryButton,
  SecondaryButton,
  EmptyBodyRow,
  RootCombinatorToggle,
  RowApplyButton,
  type FilterBarHandle,
} from "@/modules/shared/filter-bar";
import styles from "./QueryBuilder.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QueryBuilderProps {
  builder: BuilderState;
  describe: TableDescription;
  onBuilderChange(next: BuilderState): void;
  onValidityChange(isValid: boolean, reason?: string): void;
  onRun?(): void;
  onReset?(): void;
  /**
   * Called when the user clicks the per-row Apply button on filter row `index`.
   * The host receives a transient BuilderState containing only that one filter
   * row (with mode, indexName, query, filterCombinator preserved) and is
   * responsible for compiling and dispatching the scan/query.
   *
   * Option B: host-owned dispatch. QueryBuilder internally marks lastRunStateRef
   * to that transient state so the dirty pip remains accurate.
   */
  onApplyOnlyFilter?(transient: BuilderState): void;
  /** When true, all interactive controls are disabled (e.g. needs_credentials). */
  disabled?: boolean;
  /**
   * Model docs for this table. When non-empty the "By model" / "Raw (PK/SK)"
   * builder-mode toggle is shown (STD table). Empty → toggle hidden (D2).
   */
  models?: DynamoModel[];
  /** True when `models` is non-empty (STD table). */
  isStd?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers: index resolution
// ---------------------------------------------------------------------------

interface IndexOption {
  value: string | null;
  label: string;
}

function buildIndexOptions(describe: TableDescription): IndexOption[] {
  const pk = describe.key_schema.find((k) => k.key_type === "HASH");
  const sk = describe.key_schema.find((k) => k.key_type === "RANGE");
  const primaryLabel = `Primary (PK: ${pk?.attribute_name ?? "?"}${sk ? `, SK: ${sk.attribute_name}` : ""})`;

  const opts: IndexOption[] = [{ value: null, label: primaryLabel }];

  for (const gsi of describe.global_secondary_indexes) {
    const gpk = gsi.key_schema.find((k) => k.key_type === "HASH");
    const gsk = gsi.key_schema.find((k) => k.key_type === "RANGE");
    opts.push({
      value: gsi.index_name,
      label: `GSI ${gsi.index_name} (PK: ${gpk?.attribute_name ?? "?"}${gsk ? `, SK: ${gsk.attribute_name}` : ""})`,
    });
  }

  for (const lsi of describe.local_secondary_indexes) {
    const lpk = lsi.key_schema.find((k) => k.key_type === "HASH");
    const lsk = lsi.key_schema.find((k) => k.key_type === "RANGE");
    opts.push({
      value: lsi.index_name,
      label: `LSI ${lsi.index_name} (PK: ${lpk?.attribute_name ?? "?"}${lsk ? `, SK: ${lsk.attribute_name}` : ""})`,
    });
  }

  return opts;
}

/** Resolve the key schema for the currently selected index. */
function resolveKeySchema(
  builder: BuilderState,
  describe: TableDescription,
): { pkName: string; pkType: "S" | "N" | "B"; skName?: string; skType?: "S" | "N" | "B" } | null {
  let keySchema = describe.key_schema;

  if (builder.indexName !== null) {
    const gsi = describe.global_secondary_indexes.find((g) => g.index_name === builder.indexName);
    const lsi = describe.local_secondary_indexes.find((l) => l.index_name === builder.indexName);
    if (gsi) keySchema = gsi.key_schema;
    else if (lsi) keySchema = lsi.key_schema;
    else return null;
  }

  const pkEl = keySchema.find((k) => k.key_type === "HASH");
  const skEl = keySchema.find((k) => k.key_type === "RANGE");
  if (!pkEl) return null;

  const pkAttr = describe.attribute_definitions.find((a) => a.attribute_name === pkEl.attribute_name);
  const skAttr = skEl
    ? describe.attribute_definitions.find((a) => a.attribute_name === skEl.attribute_name)
    : undefined;

  return {
    pkName: pkEl.attribute_name,
    pkType: (pkAttr?.attribute_type ?? "S") as "S" | "N" | "B",
    skName: skEl?.attribute_name,
    skType: skAttr?.attribute_type as "S" | "N" | "B" | undefined,
  };
}

// ---------------------------------------------------------------------------
// Typed value editor
// ---------------------------------------------------------------------------

interface TypedValueEditorProps {
  value: TypedValue;
  onChange(next: TypedValue): void;
  /** When true, the type selector is a static badge (key picker). */
  fixedType?: "S" | "N" | "B";
  className?: string;
  "data-testid"?: string;
  /** When provided, sets `data-filter-focus-target` on the value input. */
  "data-filter-focus-target"?: string;
  onRun?(): void;
  /** "grow" stretches the input to fill remaining row width (key rows only). */
  variant?: "default" | "grow";
}

function TypedValueEditor({
  value,
  onChange,
  fixedType,
  "data-testid": testId,
  "data-filter-focus-target": focusTarget,
  onRun,
  variant,
}: TypedValueEditorProps) {
  const effectiveType = fixedType ?? value.type;
  const inputClassName = variant === "grow"
    ? `${styles.textInput} ${styles.keyValueInput}`
    : styles.textInput;

  function handleTypeChange(t: string) {
    switch (t) {
      case "S":
        onChange({ type: "S", value: "" });
        break;
      case "N":
        onChange({ type: "N", value: "" });
        break;
      case "BOOL":
        onChange({ type: "BOOL", value: false });
        break;
      case "NULL":
        onChange({ type: "NULL" });
        break;
    }
  }

  const typeSelector = fixedType ? (
    <FilterTypeBadge aria-label={`Type: ${fixedType}`}>{fixedType}</FilterTypeBadge>
  ) : (
    <select
      className={styles.filterTypeSelect}
      value={value.type}
      onChange={(e) => handleTypeChange(e.target.value)}
      aria-label="Value type"
    >
      <option value="S">S</option>
      <option value="N">N</option>
      <option value="BOOL">BOOL</option>
      <option value="NULL">NULL</option>
    </select>
  );

  let editor: React.ReactNode = null;

  if (effectiveType === "S") {
    const v = value.type === "S" ? value.value : "";
    editor = (
      <input
        type="text"
        className={inputClassName}
        value={v}
        onChange={(e) => onChange({ type: "S", value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            onRun?.();
          }
        }}
        placeholder="string value"
        data-testid={testId}
        data-filter-focus-target={focusTarget}
        aria-label="String value"
      />
    );
  } else if (effectiveType === "N") {
    const v = value.type === "N" ? value.value : "";
    editor = (
      <input
        type="text"
        inputMode="decimal"
        className={inputClassName}
        value={v}
        onChange={(e) => {
          const raw = e.target.value;
          // Allow digits, leading minus, one decimal point, exponent notation
          if (raw === "" || raw === "-" || /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d*)?$/.test(raw)) {
            onChange({ type: "N", value: raw });
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            onRun?.();
          }
        }}
        placeholder="numeric value"
        data-testid={testId}
        data-filter-focus-target={focusTarget}
        aria-label="Numeric value"
      />
    );
  } else if (effectiveType === "BOOL") {
    const v = value.type === "BOOL" ? value.value : false;
    editor = (
      <button
        type="button"
        className={styles.boolToggle}
        onClick={() => onChange({ type: "BOOL", value: !v })}
        aria-label={`Boolean value: ${v ? "true" : "false"}`}
        data-testid={testId}
        data-filter-focus-target={focusTarget}
      >
        <span className={`${styles.boolToggleTrack} ${v ? styles.boolToggleTrackOn : ""}`}>
          <span className={`${styles.boolToggleThumb} ${v ? styles.boolToggleThumbOn : ""}`} />
        </span>
        <span className={styles.boolToggleLabel}>{v ? "true" : "false"}</span>
      </button>
    );
  } else if (effectiveType === "NULL") {
    // NULL type has no value input; the type itself is the value
    editor = (
      <span className={styles.nullSwitchLabel} aria-label="NULL value" data-testid={testId}>NULL</span>
    );
  }

  return (
    <>
      {typeSelector}
      {editor}
    </>
  );
}

// ---------------------------------------------------------------------------
// Default TypedValue per schema type
// ---------------------------------------------------------------------------

function defaultTypedValue(t: "S" | "N" | "B"): TypedValue {
  return t === "N" ? { type: "N", value: "" } : { type: "S", value: "" };
}

// ---------------------------------------------------------------------------
// Filter row kinds
// ---------------------------------------------------------------------------

const COMPARE_OPS = ["=", "<>", "<", "<=", ">", ">=", "between", "contains", "begins_with"] as const;
type CompareOp = typeof COMPARE_OPS[number];

const UNARY_OPS = ["attribute_exists", "attribute_not_exists", "is_null", "is_not_null"] as const;
type UnaryOp = typeof UNARY_OPS[number];

const ALL_OPS = [
  ...COMPARE_OPS,
  ...UNARY_OPS,
  "attribute_type",
] as const;
type FilterOp = typeof ALL_OPS[number];

const ATTR_TYPES = ["S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS"] as const;

function opKind(op: FilterOp): "compare" | "unary" | "attribute_type" {
  if (UNARY_OPS.includes(op as UnaryOp)) return "unary";
  if (op === "attribute_type") return "attribute_type";
  return "compare";
}

function buildDefaultFilterRow(): FilterRow {
  return { kind: "compare", attribute: "", op: "=", value: { type: "S", value: "" } };
}

function filterRowOp(row: FilterRow): FilterOp {
  if (row.kind === "unary") return row.op;
  if (row.kind === "attribute_type") return "attribute_type";
  return row.op;
}

// ---------------------------------------------------------------------------
// FilterRowEditor
// ---------------------------------------------------------------------------

interface FilterRowEditorProps {
  row: FilterRow;
  index: number;
  onChange(next: FilterRow): void;
  onRemove(): void;
  onApplyOnly?(): void;
  /** When true, this is the first filter row and should receive the focus target marker. */
  isFirst?: boolean;
  onRun?(): void;
}

function FilterRowEditor({ row, index, onChange, onRemove, onApplyOnly, isFirst, onRun }: FilterRowEditorProps) {
  const currentOp = filterRowOp(row);

  function handleAttrChange(attr: string) {
    // Preserve everything else, just update attribute
    const next = { ...row, attribute: attr } as FilterRow;
    onChange(next);
  }

  function handleOpChange(newOp: FilterOp) {
    const newKind = opKind(newOp);
    const attr = row.attribute;

    if (newKind === "unary") {
      onChange({ kind: "unary", attribute: attr, op: newOp as UnaryOp });
    } else if (newKind === "attribute_type") {
      onChange({ kind: "attribute_type", attribute: attr, type: "S" });
    } else {
      // compare
      const op = newOp as CompareOp;
      const prevValue: TypedValue =
        row.kind === "compare" && "type" in (Array.isArray(row.value) ? {} : row.value)
          ? isTypedValue(row.value) ? row.value : row.value.min
          : { type: "S", value: "" };

      if (op === "between") {
        onChange({ kind: "compare", attribute: attr, op, value: { min: prevValue, max: prevValue } });
      } else {
        onChange({ kind: "compare", attribute: attr, op, value: prevValue });
      }
    }
  }

  let valueEditor: React.ReactNode = null;

  if (row.kind === "compare") {
    const { op, value } = row;

    if (op === "between") {
      const betweenVal = value;
      const min = isTypedValue(betweenVal) ? betweenVal : betweenVal.min;
      const max = isTypedValue(betweenVal) ? betweenVal : betweenVal.max;
      const sharedType = min.type === "N" ? "N" : "S";

      valueEditor = (
        <>
          <select
            className={styles.filterTypeSelect}
            value={sharedType}
            onChange={(e) => {
              const t = e.target.value as "S" | "N";
              onChange({
                kind: "compare",
                attribute: row.attribute,
                op: "between",
                value: {
                  min: t === "N" ? { type: "N", value: "" } : { type: "S", value: "" },
                  max: t === "N" ? { type: "N", value: "" } : { type: "S", value: "" },
                },
              });
            }}
            aria-label="Between value type"
          >
            <option value="S">S</option>
            <option value="N">N</option>
          </select>
          <input
            type="text"
            inputMode={sharedType === "N" ? "decimal" : "text"}
            className={styles.textInput}
            value={min.type === "N" || min.type === "S" ? min.value : ""}
            onChange={(e) => {
              const raw = e.target.value;
              const newMin: TypedValue = sharedType === "N" ? { type: "N", value: raw } : { type: "S", value: raw };
              onChange({
                kind: "compare",
                attribute: row.attribute,
                op: "between",
                value: { min: newMin, max },
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                onRun?.();
              }
            }}
            placeholder="min"
            aria-label={`Filter ${index} between min`}
            data-testid={`filter-${index}-between-min`}
          />
          <span className={styles.betweenAnd}>and</span>
          <input
            type="text"
            inputMode={sharedType === "N" ? "decimal" : "text"}
            className={styles.textInput}
            value={max.type === "N" || max.type === "S" ? max.value : ""}
            onChange={(e) => {
              const raw = e.target.value;
              const newMax: TypedValue = sharedType === "N" ? { type: "N", value: raw } : { type: "S", value: raw };
              onChange({
                kind: "compare",
                attribute: row.attribute,
                op: "between",
                value: { min, max: newMax },
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                onRun?.();
              }
            }}
            placeholder="max"
            aria-label={`Filter ${index} between max`}
            data-testid={`filter-${index}-between-max`}
          />
        </>
      );
    } else {
      const tv = isTypedValue(value) ? value : value.min;
      valueEditor = (
        <TypedValueEditor
          value={tv}
          onChange={(next) => onChange({ kind: "compare", attribute: row.attribute, op, value: next })}
          data-testid={`filter-${index}-value`}
          onRun={onRun}
        />
      );
    }
  } else if (row.kind === "attribute_type") {
    valueEditor = (
      <select
        className={styles.filterTypeSelect}
        value={row.type}
        onChange={(e) => {
          const t = e.target.value as FilterRow extends { kind: "attribute_type" } ? FilterRow["type"] : never;
          onChange({ kind: "attribute_type", attribute: row.attribute, type: t as "S" | "N" | "B" | "BOOL" | "NULL" | "L" | "M" | "SS" | "NS" | "BS" });
        }}
        aria-label={`Filter ${index} attribute type`}
      >
        {ATTR_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    );
  }
  // unary: no value editor

  return (
    <div className={styles.filterRow} data-testid={`filter-row-${index}`}>
      <input
        type="text"
        className={styles.filterAttrInput}
        value={row.attribute}
        onChange={(e) => handleAttrChange(e.target.value)}
        placeholder="attribute"
        aria-label={`Filter ${index} attribute name`}
        data-testid={`filter-${index}-attr`}
        data-filter-focus-target={isFirst ? "first-filter" : undefined}
      />
      <select
        className={styles.filterOpSelect}
        value={currentOp}
        onChange={(e) => handleOpChange(e.target.value as FilterOp)}
        aria-label={`Filter ${index} operator`}
        data-testid={`filter-${index}-op`}
      >
        {ALL_OPS.map((op) => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>
      {valueEditor}
      {onApplyOnly && (
        <RowApplyButton
          onClick={onApplyOnly}
          aria-label="Apply only this filter"
          title="Apply only this filter (replaces active filter)"
        />
      )}
      <button
        type="button"
        className={styles.removeBtn}
        onClick={onRemove}
        aria-label={`Remove filter ${index}`}
        data-testid={`filter-${index}-remove`}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utility: type guard for TypedValue vs { min, max }
// ---------------------------------------------------------------------------

function isTypedValue(v: TypedValue | { min: TypedValue; max: TypedValue }): v is TypedValue {
  return "type" in v;
}

// ---------------------------------------------------------------------------
// Sort-key operator selector + typed value
// ---------------------------------------------------------------------------

const SK_OPS = ["=", "<", "<=", ">", ">=", "between", "begins_with"] as const;
type SkOp = typeof SK_OPS[number];

// ---------------------------------------------------------------------------
// Dirty-state normalizer
// ---------------------------------------------------------------------------

function normalizeForDirty(builder: BuilderState): string {
  return JSON.stringify({
    mode: builder.mode,
    indexName: builder.indexName,
    query: builder.query,
    filters: builder.filters,
    filterCombinator: builder.filterCombinator,
  });
}

// ---------------------------------------------------------------------------
// Model mode helpers
// ---------------------------------------------------------------------------

/**
 * Parse distinct `${param}` identifiers from a template in order of first
 * appearance, deduplicating across pk + sk.
 * E.g. "USER#${userId}" + "ORDER#${userId}#${orderId}" → ["userId", "orderId"]
 */
function extractParams(pk: string, sk?: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const template of [pk, sk ?? ""]) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(template)) !== null) {
      const ident = m[1]!;
      if (!seen.has(ident)) {
        seen.add(ident);
        result.push(ident);
      }
    }
  }
  return result;
}

/**
 * Derive a human-readable label for an access pattern when `name` is absent.
 * Format: "<index> | pk=<pkTemplate>[, sk=<skTemplate>]"
 * Ensures two patterns on the same index are disambiguated.
 */
function deriveAccessPatternLabel(
  ap: DynamoModel["access_patterns"][number],
): string {
  if (ap.name) return ap.name;
  const parts = [`pk=${ap.pk}`];
  if (ap.sk) parts.push(`sk=${ap.sk}`);
  return `${ap.index}: ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Main QueryBuilder
// ---------------------------------------------------------------------------

// QueryBuilder is exported as a named function (forwardRef preserves the name).
export const QueryBuilder = React.forwardRef<FilterBarHandle, QueryBuilderProps>(
  function QueryBuilder(
    {
      builder,
      describe,
      onBuilderChange,
      onValidityChange,
      onRun,
      onReset,
      onApplyOnlyFilter,
      disabled = false,
      models = [],
      isStd = false,
    }: QueryBuilderProps,
    ref,
  ) {
  const [previewOpen, setPreviewOpen] = useState(false);

  // lastRunState tracks what was last executed so we can show the dirty pip
  const lastRunStateRef = useRef<string | null>(null);

  // rootRef scopes the data-filter-focus-target query inside focus()
  const rootRef = useRef<HTMLDivElement>(null);

  // Compute whether the PK value is empty (used for focus target resolution)
  const isPkEmpty = builder.mode === "query" && (() => {
    const v = builder.query?.partitionKey.value;
    if (!v) return true;
    if (v.type === "S" || v.type === "N") return v.value === "";
    if (v.type === "BOOL") return false;
    if (v.type === "NULL") return false;
    return true;
  })();

  // Expose FilterBarHandle via forwardRef
  useImperativeHandle(ref, () => ({
    focus() {
      const root = rootRef.current;
      if (!root) return;
      // Priority 1: Query mode with empty PK → focus PK value input
      if (builder.mode === "query" && isPkEmpty) {
        const pkInput = root.querySelector<HTMLElement>('[data-filter-focus-target="pk"]');
        pkInput?.focus();
        return;
      }
      // Priority 2: Filters exist → focus first filter row's attribute input
      if (builder.filters.length > 0) {
        const filterInput = root.querySelector<HTMLElement>('[data-filter-focus-target="first-filter"]');
        filterInput?.focus();
        return;
      }
      // Priority 3: Empty → focus the + Filter add button (queried by testid)
      const addBtn = root.querySelector<HTMLElement>('[data-testid="add-filter"]');
      addBtn?.focus();
    },
  }), [builder.mode, builder.filters.length, isPkEmpty]);

  // Per-row Apply handler: build a transient BuilderState with one filter,
  // mark lastRunStateRef so the dirty pip remains accurate, then delegate to host.
  function handleApplyOnlyRow(i: number) {
    const transient: BuilderState = {
      ...builder,
      filters: [builder.filters[i]!],
    };
    // Mark the transient state as last-run so pip shows divergence from full draft
    lastRunStateRef.current = normalizeForDirty(transient);
    onApplyOnlyFilter?.(transient);
  }

  const indexOptions = buildIndexOptions(describe);
  const keySchema = resolveKeySchema(builder, describe);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function setMode(mode: "scan" | "query") {
    let next: BuilderState = { ...builder, mode };
    if (mode === "query" && keySchema) {
      // Initialize query if not present
      if (!next.query) {
        next = {
          ...next,
          query: {
            partitionKey: {
              name: keySchema.pkName,
              value: defaultTypedValue(keySchema.pkType),
            },
          },
        };
      }
    }
    onBuilderChange(next);
    revalidate(next);
  }

  function setIndex(indexName: string | null) {
    const newKeySchema = resolveKeySchemaFor(indexName, describe);
    let next: BuilderState = { ...builder, indexName };

    if (builder.mode === "query" && newKeySchema) {
      next = {
        ...next,
        query: {
          partitionKey: {
            name: newKeySchema.pkName,
            value: defaultTypedValue(newKeySchema.pkType),
          },
        },
      };
    }
    onBuilderChange(next);
    revalidate(next);
  }

  function setPkValue(value: TypedValue) {
    if (!builder.query || !keySchema) return;
    const next: BuilderState = {
      ...builder,
      query: {
        ...builder.query,
        partitionKey: { name: keySchema.pkName, value },
      },
    };
    onBuilderChange(next);
    revalidate(next);
  }

  function setSkOp(op: SkOp) {
    if (!builder.query || !keySchema?.skName) return;
    const existing = builder.query.sortKey;
    const defaultVal: TypedValue = defaultTypedValue(keySchema.skType ?? "S");
    const nextSk = {
      name: keySchema.skName,
      op,
      value: op === "between"
        ? { min: existing && isTypedValue(existing.value) ? existing.value : defaultVal, max: defaultVal }
        : (existing && isTypedValue(existing.value) ? existing.value : defaultVal),
    };
    const next: BuilderState = {
      ...builder,
      query: { ...builder.query, sortKey: nextSk },
    };
    onBuilderChange(next);
    revalidate(next);
  }

  function setSkValue(value: TypedValue | { min: TypedValue; max: TypedValue }) {
    if (!builder.query?.sortKey || !keySchema?.skName) return;
    const next: BuilderState = {
      ...builder,
      query: {
        ...builder.query,
        sortKey: { ...builder.query.sortKey, value },
      },
    };
    onBuilderChange(next);
    revalidate(next);
  }

  function clearSk() {
    if (!builder.query) return;
    const { sortKey: _sk, ...rest } = builder.query;
    const next: BuilderState = { ...builder, query: rest };
    onBuilderChange(next);
    revalidate(next);
  }

  function addFilter() {
    const next: BuilderState = {
      ...builder,
      filters: [...builder.filters, buildDefaultFilterRow()],
    };
    onBuilderChange(next);
    revalidate(next);
  }

  function updateFilter(index: number, row: FilterRow) {
    const filters = builder.filters.map((r, i) => (i === index ? row : r));
    const next: BuilderState = { ...builder, filters };
    onBuilderChange(next);
    revalidate(next);
  }

  function removeFilter(index: number) {
    const filters = builder.filters.filter((_, i) => i !== index);
    const next: BuilderState = { ...builder, filters };
    onBuilderChange(next);
    revalidate(next);
  }

  function revalidate(next: BuilderState) {
    // In model mode, the query is derived from modelSelection — validate that.
    const effectiveMode: "model" | "raw" =
      isStd && next.builderMode === "model" ? "model" : "raw";
    if (effectiveMode === "model" && next.modelSelection && selectedAp) {
      const modelResult = compileModel(selectedAp, next.modelSelection.params, describe);
      if (modelResult.kind === "error") {
        onValidityChange(false, modelResult.reason);
        return;
      }
      // Also validate filters via builderCompiler
      const fullResult = compile(
        { ...next, indexName: modelResult.indexName, query: modelResult.query },
        describe,
      );
      if (fullResult.kind === "error") {
        onValidityChange(false, fullResult.reason);
      } else {
        onValidityChange(true);
      }
      return;
    }
    const result = compile(next, describe);
    if (result.kind === "error") {
      onValidityChange(false, result.reason);
    } else {
      onValidityChange(true);
    }
  }

  function handleRun() {
    // Mark current state as last-run so pip clears
    lastRunStateRef.current = normalizeForDirty(builder);
    if (onRun) onRun();
  }

  function handleReset() {
    // After reset the state will change; we track the clean reset state
    if (onReset) onReset();
    // Clear lastRunState so pip is not shown in cleaned state
    lastRunStateRef.current = null;
  }

  // ── Model mode: derived state ──────────────────────────────────────────────
  // The effective builder mode: force "raw" when not STD.
  const effectiveBuilderMode: "model" | "raw" =
    isStd && builder.builderMode === "model" ? "model" : "raw";

  // The currently selected entity model (by name from modelSelection).
  const selectedModel = useMemo(
    () =>
      builder.modelSelection?.entity
        ? models.find((m) => m.name === builder.modelSelection!.entity) ?? null
        : null,
    [builder.modelSelection, models],
  );

  // The currently selected access pattern (by string label key, stored in
  // modelSelection.accessPattern which is the derived label for the pattern).
  const selectedAp = useMemo(() => {
    if (!selectedModel || !builder.modelSelection?.accessPattern) return null;
    return (
      selectedModel.access_patterns.find(
        (ap) => deriveAccessPatternLabel(ap) === builder.modelSelection!.accessPattern,
      ) ?? null
    );
  }, [selectedModel, builder.modelSelection]);

  // Params list for the selected access pattern (ordered, deduped).
  const apParams = useMemo(
    () => (selectedAp ? extractParams(selectedAp.pk, selectedAp.sk) : []),
    [selectedAp],
  );

  // ── Model compile result (model mode only) ─────────────────────────────────
  const modelCompileResult = useMemo(() => {
    if (effectiveBuilderMode !== "model" || !selectedAp) return null;
    const params = builder.modelSelection?.params ?? {};
    return compileModel(selectedAp, params, describe);
  }, [effectiveBuilderMode, selectedAp, builder.modelSelection, describe]);

  // ── Model mode handlers ────────────────────────────────────────────────────

  /** Switch builder mode between "model" and "raw". */
  function setBuilderMode(mode: "model" | "raw") {
    let next: BuilderState;
    if (mode === "model") {
      // Entering model mode: derive query from current modelSelection
      next = { ...builder, builderMode: "model" };
      if (builder.modelSelection) {
        const ap = models
          .find((m) => m.name === builder.modelSelection!.entity)
          ?.access_patterns.find(
            (p) => deriveAccessPatternLabel(p) === builder.modelSelection!.accessPattern,
          );
        if (ap) {
          const result = compileModel(ap, builder.modelSelection.params, describe);
          if (result.kind === "ok") {
            next = { ...next, indexName: result.indexName, query: result.query };
          }
        }
      }
    } else {
      // Switching to raw: keep the last compiled query seeded from model state
      next = { ...builder, builderMode: "raw" };
    }
    onBuilderChange(next);
    // Revalidate via builderCompiler (model-derived query satisfies it)
    const result = compile(next, describe);
    if (result.kind === "error") {
      onValidityChange(false, result.reason);
    } else {
      onValidityChange(true);
    }
  }

  /** Select an entity model. Resets access pattern and params. */
  function setModelEntity(entityName: string) {
    const model = models.find((m) => m.name === entityName);
    if (!model) return;
    // Pick first access pattern as default
    const firstAp = model.access_patterns[0];
    const apLabel = firstAp ? deriveAccessPatternLabel(firstAp) : "";
    const next: BuilderState = {
      ...builder,
      builderMode: "model",
      modelSelection: { entity: entityName, accessPattern: apLabel, params: {} },
    };
    // Compile immediately
    if (firstAp) {
      const result = compileModel(firstAp, {}, describe);
      if (result.kind === "ok") {
        onBuilderChange({ ...next, indexName: result.indexName, query: result.query });
        onValidityChange(true);
      } else {
        onBuilderChange(next);
        onValidityChange(false, result.reason);
      }
    } else {
      onBuilderChange(next);
      onValidityChange(false, "No access patterns defined for this entity");
    }
  }

  /** Select an access pattern (by derived label). Resets params. */
  function setModelAccessPattern(apLabel: string) {
    if (!builder.modelSelection) return;
    const model = models.find((m) => m.name === builder.modelSelection!.entity);
    if (!model) return;
    const ap = model.access_patterns.find((p) => deriveAccessPatternLabel(p) === apLabel);
    if (!ap) return;
    const next: BuilderState = {
      ...builder,
      modelSelection: { ...builder.modelSelection, accessPattern: apLabel, params: {} },
    };
    const result = compileModel(ap, {}, describe);
    if (result.kind === "ok") {
      onBuilderChange({ ...next, indexName: result.indexName, query: result.query });
      onValidityChange(true);
    } else {
      onBuilderChange(next);
      onValidityChange(false, result.reason);
    }
  }

  /** Update a single param value in model mode. */
  function setModelParam(paramName: string, value: string) {
    if (!builder.modelSelection || !selectedAp) return;
    const nextParams = { ...builder.modelSelection.params, [paramName]: value };
    const next: BuilderState = {
      ...builder,
      modelSelection: { ...builder.modelSelection, params: nextParams },
    };
    const result = compileModel(selectedAp, nextParams, describe);
    if (result.kind === "ok") {
      onBuilderChange({ ...next, indexName: result.indexName, query: result.query });
      onValidityChange(true);
    } else {
      onBuilderChange(next);
      onValidityChange(false, result.reason);
    }
  }

  // ── Compute validity for inline hints ──────────────────────────────────────
  // In model mode: use model compile result; in raw mode: use builderCompiler.
  const compileResult = (() => {
    if (effectiveBuilderMode === "model") {
      if (modelCompileResult === null) {
        // No AP selected yet — entity or AP missing
        return { kind: "error" as const, reason: "Select an entity and access pattern", field: undefined };
      }
      if (modelCompileResult.kind === "error") {
        return { kind: "error" as const, reason: modelCompileResult.reason, field: modelCompileResult.field };
      }
      // ok — run through builderCompiler for the preview/validity (it already validates key types etc.)
      return compile({ ...builder, indexName: modelCompileResult.indexName, query: modelCompileResult.query }, describe);
    }
    return compile(builder, describe);
  })();

  const isValid = compileResult.kind !== "error";
  const validityField = compileResult.kind === "error" ? compileResult.field : undefined;
  const validityReason = compileResult.kind === "error" ? compileResult.reason : undefined;

  // ── Partition key hint ─────────────────────────────────────────────────────
  const pkHint = builder.mode === "query" && !isValid && validityField === "partitionKey"
    ? validityReason
    : undefined;

  const pkTypeMismatch = builder.mode === "query" && !isValid && validityField === "partitionKey" && validityReason?.includes("type");

  // ── Sort key picker: visible in Query mode + index has SK ─────────────────
  const showSortKey = builder.mode === "query" && !!keySchema?.skName;

  // ── Dirty pip ─────────────────────────────────────────────────────────────
  const currentStateNormalized = normalizeForDirty(builder);
  const isDirty = lastRunStateRef.current !== null
    ? lastRunStateRef.current !== currentStateNormalized
    : false;

  const canRun = isValid && !disabled;

  return (
    <div ref={rootRef}>
    <FilterBarShell>
      {/* ── Header: mode toggle + builder-mode toggle + index ──────────── */}
      <FilterBarHeader>
        {/* Scan/Query segmented control — custom tablist to preserve aria-pressed
            test assertions (data-testid="mode-scan/query" + aria-pressed). */}
        <div className={styles.modeGroup} role="group" aria-label="Data mode">
          <button
            type="button"
            className={`${styles.modeBtn} ${builder.mode === "scan" ? styles.modeBtnActive : ""}`}
            onClick={() => setMode("scan")}
            aria-pressed={builder.mode === "scan"}
            disabled={disabled}
            data-testid="mode-scan"
          >
            Scan
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${builder.mode === "query" ? styles.modeBtnActive : ""}`}
            onClick={() => setMode("query")}
            aria-pressed={builder.mode === "query"}
            disabled={disabled}
            data-testid="mode-query"
          >
            Query
          </button>
        </div>

        {/* Builder-mode toggle: "By model" / "Raw (PK/SK)" — STD tables only (D2) */}
        {isStd && builder.mode === "query" && (
          <div className={styles.modeGroup} role="group" aria-label="Builder mode" data-testid="builder-mode-group">
            <button
              type="button"
              className={`${styles.modeBtn} ${effectiveBuilderMode === "model" ? styles.modeBtnActive : ""}`}
              onClick={() => setBuilderMode("model")}
              aria-pressed={effectiveBuilderMode === "model"}
              disabled={disabled}
              data-testid="builder-mode-model"
            >
              By model
            </button>
            <button
              type="button"
              className={`${styles.modeBtn} ${effectiveBuilderMode === "raw" ? styles.modeBtnActive : ""}`}
              onClick={() => setBuilderMode("raw")}
              aria-pressed={effectiveBuilderMode === "raw"}
              disabled={disabled}
              data-testid="builder-mode-raw"
            >
              Raw (PK/SK)
            </button>
          </div>
        )}

        {/* Index dropdown — hidden in model mode (index is derived from access pattern) */}
        {effectiveBuilderMode === "raw" && (
          <>
            <span className={styles.label}>Index</span>
            <select
              className={styles.select}
              value={builder.indexName ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setIndex(v === "" ? null : v);
              }}
              aria-label="Index"
              disabled={disabled}
              data-testid="index-select"
            >
              {indexOptions.map((opt) => (
                <option key={opt.value ?? ""} value={opt.value ?? ""}>{opt.label}</option>
              ))}
            </select>
          </>
        )}
      </FilterBarHeader>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <FilterBarBody>
        {/* Model mode — entity + access pattern + param inputs */}
        {effectiveBuilderMode === "model" && builder.mode === "query" && (
          <div className={styles.keySection}>
            {/* Entity selector */}
            <div className={styles.keyRow}>
              <span className={styles.keyLabel}>Entity</span>
              <select
                className={styles.select}
                value={builder.modelSelection?.entity ?? ""}
                onChange={(e) => setModelEntity(e.target.value)}
                aria-label="Entity"
                disabled={disabled}
                data-testid="model-entity-select"
              >
                {!builder.modelSelection?.entity && (
                  <option value="">— select entity —</option>
                )}
                {models.map((m) => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))}
              </select>
            </div>

            {/* Access pattern selector */}
            {selectedModel && (
              <div className={styles.keyRow}>
                <span className={styles.keyLabel}>Access pattern</span>
                <select
                  className={styles.select}
                  value={builder.modelSelection?.accessPattern ?? ""}
                  onChange={(e) => setModelAccessPattern(e.target.value)}
                  aria-label="Access pattern"
                  disabled={disabled}
                  data-testid="model-ap-select"
                >
                  {!builder.modelSelection?.accessPattern && (
                    <option value="">— select pattern —</option>
                  )}
                  {selectedModel.access_patterns.map((ap) => {
                    const label = deriveAccessPatternLabel(ap);
                    return (
                      <option key={label} value={label}>{label}</option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* Parameter inputs — one per distinct ${param} in the chosen pattern */}
            {selectedAp && apParams.map((param) => (
              <div key={param} className={styles.keyRow}>
                <span className={styles.keyLabel}>{param}</span>
                <input
                  type="text"
                  className={`${styles.textInput} ${styles.keyValueInput}`}
                  value={builder.modelSelection?.params[param] ?? ""}
                  onChange={(e) => setModelParam(param, e.target.value)}
                  placeholder={`value for ${param}`}
                  aria-label={`Parameter ${param}`}
                  data-testid={`model-param-${param}`}
                  disabled={disabled}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                      e.preventDefault();
                      handleRun();
                    }
                  }}
                />
              </div>
            ))}

            {/* Model compile error hint */}
            {modelCompileResult?.kind === "error" && (
              <div className={styles.keyRow}>
                <span className={styles.hint} role="alert" data-testid="model-compile-error">
                  {modelCompileResult.reason}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Key section — Raw Query mode only */}
        {effectiveBuilderMode === "raw" && builder.mode === "query" && keySchema && (
          <div className={styles.keySection}>
            {/* Partition key */}
            <div className={styles.keyRow}>
              <span className={styles.keyLabel}>Partition key</span>
              <FilterTypeBadge aria-label={`PK type: ${keySchema.pkType}`}>{keySchema.pkType}</FilterTypeBadge>
              <TypedValueEditor
                value={builder.query?.partitionKey.value ?? defaultTypedValue(keySchema.pkType)}
                onChange={setPkValue}
                fixedType={keySchema.pkType}
                data-testid="pk-value"
                data-filter-focus-target={isPkEmpty ? "pk" : undefined}
                variant="grow"
              />
              {pkHint && (
                <span className={styles.hint} role="alert" data-testid="pk-hint">
                  {pkTypeMismatch ? `Expected ${keySchema.pkType}` : pkHint}
                </span>
              )}
            </div>

            {/* Sort key (visible only when the index has a SK) */}
            {showSortKey && (
              <div className={styles.keyRow}>
                <span className={styles.keyLabel}>Sort key</span>
                <FilterTypeBadge aria-label={`SK type: ${keySchema.skType}`}>{keySchema.skType ?? "S"}</FilterTypeBadge>

                {builder.query?.sortKey ? (
                  <>
                    <select
                      className={styles.skOpSelect}
                      value={builder.query.sortKey.op}
                      onChange={(e) => setSkOp(e.target.value as SkOp)}
                      aria-label="Sort key operator"
                      data-testid="sk-op"
                    >
                      {SK_OPS.map((op) => (
                        <option key={op} value={op}>{op}</option>
                      ))}
                    </select>

                    {builder.query.sortKey.op === "between" ? (
                      <>
                        <input
                          type="text"
                          inputMode={keySchema.skType === "N" ? "decimal" : "text"}
                          className={styles.textInput}
                          value={
                            !isTypedValue(builder.query.sortKey.value)
                              ? (builder.query.sortKey.value.min.type === "N" || builder.query.sortKey.value.min.type === "S"
                                ? builder.query.sortKey.value.min.value
                                : "")
                              : ""
                          }
                          onChange={(e) => {
                            const existing = builder.query!.sortKey!;
                            const prevMax = !isTypedValue(existing.value) ? existing.value.max : defaultTypedValue(keySchema.skType ?? "S");
                            const newMin: TypedValue = keySchema.skType === "N"
                              ? { type: "N", value: e.target.value }
                              : { type: "S", value: e.target.value };
                            setSkValue({ min: newMin, max: prevMax });
                          }}
                          placeholder="min"
                          aria-label="Sort key between min"
                          data-testid="sk-between-min"
                        />
                        <span className={styles.betweenAnd}>and</span>
                        <input
                          type="text"
                          inputMode={keySchema.skType === "N" ? "decimal" : "text"}
                          className={styles.textInput}
                          value={
                            !isTypedValue(builder.query.sortKey.value)
                              ? (builder.query.sortKey.value.max.type === "N" || builder.query.sortKey.value.max.type === "S"
                                ? builder.query.sortKey.value.max.value
                                : "")
                              : ""
                          }
                          onChange={(e) => {
                            const existing = builder.query!.sortKey!;
                            const prevMin = !isTypedValue(existing.value) ? existing.value.min : defaultTypedValue(keySchema.skType ?? "S");
                            const newMax: TypedValue = keySchema.skType === "N"
                              ? { type: "N", value: e.target.value }
                              : { type: "S", value: e.target.value };
                            setSkValue({ min: prevMin, max: newMax });
                          }}
                          placeholder="max"
                          aria-label="Sort key between max"
                          data-testid="sk-between-max"
                        />
                      </>
                    ) : (
                      <input
                        type="text"
                        inputMode={keySchema.skType === "N" ? "decimal" : "text"}
                        className={`${styles.textInput} ${styles.keyValueInput}`}
                        value={
                          isTypedValue(builder.query.sortKey.value)
                            ? (builder.query.sortKey.value.type === "N" || builder.query.sortKey.value.type === "S"
                              ? builder.query.sortKey.value.value
                              : "")
                            : ""
                        }
                        onChange={(e) => {
                          const newVal: TypedValue = keySchema.skType === "N"
                            ? { type: "N", value: e.target.value }
                            : { type: "S", value: e.target.value };
                          setSkValue(newVal);
                        }}
                        placeholder="sort key value"
                        aria-label="Sort key value"
                        data-testid="sk-value"
                      />
                    )}

                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={clearSk}
                      aria-label="Remove sort key clause"
                      data-testid="sk-remove"
                      title="Remove sort key clause"
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <FilterRowAddButton
                    onClick={() => {
                      if (!keySchema?.skName) return;
                      const defaultSk = {
                        name: keySchema.skName,
                        op: "=" as SkOp,
                        value: defaultTypedValue(keySchema.skType ?? "S"),
                      };
                      const next: BuilderState = {
                        ...builder,
                        query: { ...builder.query!, sortKey: defaultSk },
                      };
                      onBuilderChange(next);
                      revalidate(next);
                    }}
                    data-testid="sk-add"
                  >
                    + Add sort key clause
                  </FilterRowAddButton>
                )}
              </div>
            )}
          </div>
        )}

        {/* Filters section */}
        <div className={styles.filtersSection}>
          {builder.filters.length === 0 ? (
            <EmptyBodyRow label="No filters">
              <FilterRowAddButton
                key="add"
                onClick={addFilter}
                data-testid="add-filter"
              >
                + Filter
              </FilterRowAddButton>
            </EmptyBodyRow>
          ) : (
            <>
              {builder.filters.map((row, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <FilterConnector label={getFilterCombinator(builder)} />}
                  <FilterRowEditor
                    row={row}
                    index={i}
                    onChange={(next) => updateFilter(i, next)}
                    onRemove={() => removeFilter(i)}
                    onApplyOnly={onApplyOnlyFilter ? () => handleApplyOnlyRow(i) : undefined}
                    isFirst={i === 0}
                    onRun={handleRun}
                  />
                </React.Fragment>
              ))}
              <div className={styles.filtersActions}>
                {/* AND|OR toggle — hidden when no filters */}
                <RootCombinatorToggle
                  value={getFilterCombinator(builder)}
                  onChange={(c) => {
                    const next = { ...builder, filterCombinator: c };
                    onBuilderChange(next);
                    revalidate(next);
                  }}
                  aria-label="Filter combinator"
                />
                <FilterRowAddButton
                  onClick={addFilter}
                  data-testid="add-filter"
                >
                  + Filter
                </FilterRowAddButton>
              </div>
            </>
          )}
        </div>

        {/* Preview disclosure */}
        <div className={styles.previewSection}>
          <button
            type="button"
            className={styles.previewToggle}
            onClick={() => setPreviewOpen((o) => !o)}
            aria-expanded={previewOpen}
            data-testid="preview-toggle"
          >
            <span className={`${styles.previewCaret} ${previewOpen ? styles.previewCaretOpen : ""}`}>▶</span>
            Preview compiled expression
          </button>

          {previewOpen && (
            <div className={styles.previewBody} data-testid="preview-body">
              {compileResult.kind === "error" ? (
                <span className={styles.previewError} role="alert" data-testid="preview-error">
                  {compileResult.reason}
                </span>
              ) : (
                <>
                  {compileResult.kind === "query" && (
                    <div>
                      <div className={styles.previewLabel}>KeyConditionExpression</div>
                      <pre className={styles.previewCode} data-testid="preview-kce">
                        {compileResult.request.key_condition_expression}
                      </pre>
                    </div>
                  )}
                  {(compileResult.request.filter_expression) && (
                    <div>
                      <div className={styles.previewLabel}>FilterExpression</div>
                      <pre className={styles.previewCode} data-testid="preview-fe">
                        {compileResult.request.filter_expression}
                      </pre>
                    </div>
                  )}
                  {compileResult.request.expression_attribute_names && (
                    <div>
                      <div className={styles.previewLabel}>ExpressionAttributeNames</div>
                      <pre className={styles.previewCode} data-testid="preview-names">
                        {JSON.stringify(compileResult.request.expression_attribute_names, null, 2)}
                      </pre>
                    </div>
                  )}
                  {compileResult.request.expression_attribute_values && (
                    <div>
                      <div className={styles.previewLabel}>ExpressionAttributeValues</div>
                      <pre className={styles.previewCode} data-testid="preview-values">
                        {JSON.stringify(compileResult.request.expression_attribute_values, null, 2)}
                      </pre>
                    </div>
                  )}
                  {compileResult.kind === "scan" && !compileResult.request.filter_expression && (
                    <span className={styles.previewCode} style={{ color: "var(--text-subtle)" }}>
                      No filter expression (full scan)
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </FilterBarBody>

      {/* ── Action row ─────────────────────────────────────────────────── */}
      <FilterBarActions
        left={
          <>
            <SecondaryButton onClick={handleReset} disabled={disabled}>Reset</SecondaryButton>
            <FilterKeyHint keys="⌘⇧R" />
          </>
        }
        right={
          <>
            <FilterKeyHint keys="⌘↵" />
            <PrimaryButton
              onClick={handleRun}
              dirty={isDirty}
              disabled={!canRun}
            >
              Run
            </PrimaryButton>
          </>
        }
      />
    </FilterBarShell>
    </div>
  );
  },
);

QueryBuilder.displayName = "QueryBuilder";

// ---------------------------------------------------------------------------
// Private helper: resolveKeySchema for a specific indexName
// ---------------------------------------------------------------------------

function resolveKeySchemaFor(
  indexName: string | null,
  describe: TableDescription,
): { pkName: string; pkType: "S" | "N" | "B"; skName?: string; skType?: "S" | "N" | "B" } | null {
  let keySchema = describe.key_schema;

  if (indexName !== null) {
    const gsi = describe.global_secondary_indexes.find((g) => g.index_name === indexName);
    const lsi = describe.local_secondary_indexes.find((l) => l.index_name === indexName);
    if (gsi) keySchema = gsi.key_schema;
    else if (lsi) keySchema = lsi.key_schema;
    else return null;
  }

  const pkEl = keySchema.find((k) => k.key_type === "HASH");
  const skEl = keySchema.find((k) => k.key_type === "RANGE");
  if (!pkEl) return null;

  const pkAttr = describe.attribute_definitions.find((a) => a.attribute_name === pkEl.attribute_name);
  const skAttr = skEl
    ? describe.attribute_definitions.find((a) => a.attribute_name === skEl.attribute_name)
    : undefined;

  return {
    pkName: pkEl.attribute_name,
    pkType: (pkAttr?.attribute_type ?? "S") as "S" | "N" | "B",
    skName: skEl?.attribute_name,
    skType: skAttr?.attribute_type as "S" | "N" | "B" | undefined,
  };
}

