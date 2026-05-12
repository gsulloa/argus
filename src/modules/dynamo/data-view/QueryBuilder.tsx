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

import { useState } from "react";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { compile } from "./builderCompiler";
import type { BuilderState, FilterRow, TypedValue } from "./types";
import styles from "./QueryBuilder.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QueryBuilderProps {
  builder: BuilderState;
  describe: TableDescription;
  onBuilderChange(next: BuilderState): void;
  onValidityChange(isValid: boolean, reason?: string): void;
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
}

function TypedValueEditor({
  value,
  onChange,
  fixedType,
  "data-testid": testId,
}: TypedValueEditorProps) {
  const effectiveType = fixedType ?? value.type;

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
    <span className={styles.typeBadge} aria-label={`Type: ${fixedType}`}>{fixedType}</span>
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
        className={styles.textInput}
        value={v}
        onChange={(e) => onChange({ type: "S", value: e.target.value })}
        placeholder="string value"
        data-testid={testId}
        aria-label="String value"
      />
    );
  } else if (effectiveType === "N") {
    const v = value.type === "N" ? value.value : "";
    editor = (
      <input
        type="text"
        inputMode="decimal"
        className={styles.textInput}
        value={v}
        onChange={(e) => {
          const raw = e.target.value;
          // Allow digits, leading minus, one decimal point, exponent notation
          if (raw === "" || raw === "-" || /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d*)?$/.test(raw)) {
            onChange({ type: "N", value: raw });
          }
        }}
        placeholder="numeric value"
        data-testid={testId}
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
}

function FilterRowEditor({ row, index, onChange, onRemove }: FilterRowEditorProps) {
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
// Main QueryBuilder
// ---------------------------------------------------------------------------

export function QueryBuilder({
  builder,
  describe,
  onBuilderChange,
  onValidityChange,
}: QueryBuilderProps) {
  const [previewOpen, setPreviewOpen] = useState(false);

  const indexOptions = buildIndexOptions(describe);
  const keySchema = resolveKeySchema(builder, describe);

  // ── Validity check ─────────────────────────────────────────────────────────
  // We compute validity inline and call onValidityChange. Since this is a
  // render-time side-effect pattern, we do it synchronously in the render by
  // computing validity and comparing with a ref-like approach — but to keep
  // this pure and avoid useEffect ordering issues, we let the parent call
  // compile() as well. Here we just fire the callback after each change.

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
    const result = compile(next, describe);
    if (result.kind === "error") {
      onValidityChange(false, result.reason);
    } else {
      onValidityChange(true);
    }
  }

  // ── Compute validity for inline hints ──────────────────────────────────────
  const compileResult = compile(builder, describe);
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

  return (
    <div className={styles.root}>
      {/* ── Top row: mode + index ─────────────────────────────────────── */}
      <div className={styles.topRow}>
        {/* Mode segmented control */}
        <div className={styles.modeGroup} role="group" aria-label="Data mode">
          <button
            type="button"
            className={`${styles.modeBtn} ${builder.mode === "scan" ? styles.modeBtnActive : ""}`}
            onClick={() => setMode("scan")}
            aria-pressed={builder.mode === "scan"}
            data-testid="mode-scan"
          >
            Scan
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${builder.mode === "query" ? styles.modeBtnActive : ""}`}
            onClick={() => setMode("query")}
            aria-pressed={builder.mode === "query"}
            data-testid="mode-query"
          >
            Query
          </button>
        </div>

        {/* Index dropdown */}
        <span className={styles.label}>Index</span>
        <select
          className={styles.select}
          value={builder.indexName ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setIndex(v === "" ? null : v);
          }}
          aria-label="Index"
          data-testid="index-select"
        >
          {indexOptions.map((opt) => (
            <option key={opt.value ?? ""} value={opt.value ?? ""}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* ── Key pickers (Query mode only) ─────────────────────────────── */}
      {builder.mode === "query" && keySchema && (
        <div className={styles.keySection}>
          {/* Partition key */}
          <div className={styles.keyRow}>
            <span className={styles.keyLabel}>Partition key</span>
            <span className={styles.typeBadge} aria-label={`PK type: ${keySchema.pkType}`}>{keySchema.pkType}</span>
            <TypedValueEditor
              value={builder.query?.partitionKey.value ?? defaultTypedValue(keySchema.pkType)}
              onChange={setPkValue}
              fixedType={keySchema.pkType}
              data-testid="pk-value"
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
              <span className={styles.typeBadge} aria-label={`SK type: ${keySchema.skType}`}>{keySchema.skType ?? "S"}</span>

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
                      className={styles.textInput}
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
                <button
                  type="button"
                  className={styles.addFilterBtn}
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
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Filter rows ────────────────────────────────────────────────── */}
      <div className={styles.filtersSection}>
        {builder.filters.length > 0 && (
          <div className={styles.filterRows}>
            {builder.filters.map((row, i) => (
              <FilterRowEditor
                key={i}
                row={row}
                index={i}
                onChange={(next) => updateFilter(i, next)}
                onRemove={() => removeFilter(i)}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          className={styles.addFilterBtn}
          onClick={addFilter}
          data-testid="add-filter"
        >
          + Add filter
        </button>
      </div>

      {/* ── Preview disclosure ─────────────────────────────────────────── */}
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
    </div>
  );
}

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
