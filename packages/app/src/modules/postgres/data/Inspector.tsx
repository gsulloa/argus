import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Undo2 } from "lucide-react";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";
import { isCellEnvelope, type CellEnvelope, type CellValue, type DataColumn, type EditValue } from "./types";
import { categorize, isMonoCategory } from "./typeHelpers";
import type { UseEditBufferResult } from "./useEditBuffer";
import { looksLikeBytea } from "./EditableCell";
import { validateJsonInput, hasSmartQuotes } from "./jsonEditValidation";
import styles from "./Inspector.module.css";

// --------------------------------------------------------------------------
// Row shape passed in from TableViewerTab
// --------------------------------------------------------------------------
export interface SelectedRow {
  rowKey: string;
  row: CellValue[];
  pk: Record<string, EditValue>;
  source: "insert" | "server";
  isDeleted: boolean;
}

interface Props {
  columns: DataColumn[];
  /** All rows in the current selection range (0..N). Filtering to eligible
   *  rows happens inside the inspector. */
  selectedRows: SelectedRow[];
  /** True when the connection is writable and pkColumns !== null. */
  bulkEditAvailable: boolean;
  isReadOnly: boolean;
  pkColumns: string[] | null;
  enumValuesByColumn: Record<string, string[]>;
  buffer: UseEditBufferResult;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatScalar(value: CellValue | EditValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function EnvelopeField({ envelope }: { envelope: CellEnvelope }) {
  const label = envelope.kind === "binary" ? "binary" : "truncated";
  return (
    <div>
      <span className={styles.envelopeChip}>
        {label} ~{humanBytes(envelope.byte_length)}
      </span>
      <div className={styles.envelopePreview}>{envelope.preview}</div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Main Inspector export
// --------------------------------------------------------------------------
export function Inspector({
  columns,
  selectedRows,
  bulkEditAvailable,
  isReadOnly,
  pkColumns,
  enumValuesByColumn,
  buffer,
}: Props) {
  // Determine eligible rows (server, not deleted, has rowKey).
  const eligibleRows = useMemo(
    () =>
      selectedRows.filter(
        (r) => r.source === "server" && !r.isDeleted && r.rowKey,
      ),
    [selectedRows],
  );

  const mode: "single" | "bulk" =
    eligibleRows.length >= 2 && bulkEditAvailable ? "bulk" : "single";

  // -----------------------------------------------------------------------
  // SINGLE mode
  // -----------------------------------------------------------------------
  if (mode === "single") {
    const activeRow = selectedRows[selectedRows.length - 1] ?? null;

    if (!activeRow) {
      return (
        <div className={styles.root}>
          <div className={styles.header}>Inspector</div>
          <div className={styles.empty}>Select a row to inspect.</div>
        </div>
      );
    }

    const row = activeRow.row;
    const rowKey = activeRow.rowKey || null;

    return (
      <div className={styles.root}>
        <div className={styles.header}>Inspector</div>
        <div className={styles.body}>
          {columns.map((col, i) => {
            const serverValue = (row[i] ?? null) as CellValue;
            const cat = categorize(col.data_type);
            const isEnvelope = isCellEnvelope(serverValue);
            const dirty = rowKey ? buffer.isCellDirty(rowKey, col.name) : false;
            const editsEntry = rowKey ? buffer.getRowEdits(rowKey) : undefined;
            const isInsertRow = editsEntry?.kind === "insert";
            const isDeleted = editsEntry?.kind === "delete";
            const displayValue =
              editsEntry && col.name in editsEntry.changes
                ? (editsEntry.changes[col.name] as EditValue)
                : serverValue;
            const isPkOfExisting = !isInsertRow && pkColumns?.includes(col.name);
            const fieldReadOnly =
              isReadOnly ||
              isDeleted ||
              (isPkOfExisting ?? false) ||
              looksLikeBytea(col.data_type) ||
              isEnvelope ||
              (!isInsertRow && pkColumns === null) ||
              !rowKey;

            return (
              <div key={col.name} className={styles.field}>
                <div className={styles.label}>
                  <span>
                    {col.name}
                    {dirty ? (
                      <span className={styles.dirtyDot} aria-label="dirty">
                        ●
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.type}>{col.data_type}</span>
                </div>
                {isEnvelope ? (
                  <EnvelopeField envelope={serverValue as CellEnvelope} />
                ) : fieldReadOnly ? (
                  displayValue === null || displayValue === undefined ? (
                    <span className={styles.null}>NULL</span>
                  ) : (
                    <div
                      className={`${styles.value} ${
                        isMonoCategory(cat) || cat === "json" || cat === "uuid"
                          ? styles.valueMono
                          : ""
                      }`}
                    >
                      {formatScalar(displayValue)}
                    </div>
                  )
                ) : (
                  <InspectorEditableField
                    // Force a remount whenever the selected row changes (or
                    // an external buffer edit lands on this row+column). The
                    // local `text` state inside the field would otherwise leak
                    // across rows: typing in field A then selecting row B would
                    // show A's typed value in B and, on blur, write A's value
                    // into B's buffer entry.
                    key={`${rowKey ?? "none"}:${col.name}`}
                    column={col}
                    value={displayValue}
                    enumValues={enumValuesByColumn[col.name]}
                    onChange={(next) => {
                      if (!rowKey) return;
                      const pk: Record<string, EditValue> = {};
                      if (pkColumns) {
                        for (const c of pkColumns) {
                          const idx = columns.findIndex((cc) => cc.name === c);
                          if (idx >= 0) pk[c] = (row[idx] ?? null) as EditValue;
                        }
                      }
                      buffer.setCellEdit({
                        rowKey,
                        column: col.name,
                        value: next,
                        pk,
                        originalRow: row,
                        originalColumns: columns.map((c) => c.name),
                      });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // BULK mode
  // -----------------------------------------------------------------------
  return (
    <BulkInspector
      columns={columns}
      eligibleRows={eligibleRows}
      selectedRows={selectedRows}
      bulkEditAvailable={bulkEditAvailable}
      isReadOnly={isReadOnly}
      pkColumns={pkColumns}
      enumValuesByColumn={enumValuesByColumn}
      buffer={buffer}
    />
  );
}

// --------------------------------------------------------------------------
// BulkInspector — rendered when mode === "bulk"
// --------------------------------------------------------------------------
interface BulkInspectorProps {
  columns: DataColumn[];
  eligibleRows: SelectedRow[];
  selectedRows: SelectedRow[];
  bulkEditAvailable: boolean;
  isReadOnly: boolean;
  pkColumns: string[] | null;
  enumValuesByColumn: Record<string, string[]>;
  buffer: UseEditBufferResult;
}

// Used to bump a key after Apply so all InspectorBulkField components remount
// and initialize from the newly-applied values.
function BulkInspector({
  columns,
  eligibleRows,
  selectedRows,
  bulkEditAvailable,
  isReadOnly,
  pkColumns,
  enumValuesByColumn,
  buffer,
}: BulkInspectorProps) {
  // Key that resets bulk body when row identity changes or after apply.
  const selectionKey = eligibleRows.map((r) => r.rowKey).join(",");
  const [appliedTick, setAppliedTick] = useState(0);

  // Imperative ref registry so we can validate + collect values on Apply
  // without lifting all text state into the parent, which would re-render
  // every keystroke.
  type FieldRegistry = {
    getValue: () => { ok: true; value: EditValue } | { ok: false; error: string };
    setError: (err: string | null) => void;
    resetToPristine: () => void;
  };
  const fieldRegistryRef = useRef<Map<string, FieldRegistry>>(new Map());

  // Track which columns are touched.
  const [touchedColumns, setTouchedColumns] = useState<Set<string>>(new Set());
  const touchedCount = touchedColumns.size;

  function handleTouchedChange(columnName: string, touched: boolean) {
    setTouchedColumns((prev) => {
      const next = new Set(prev);
      if (touched) {
        next.add(columnName);
      } else {
        next.delete(columnName);
      }
      return next;
    });
  }

  function registerField(
    columnName: string,
    getValue: () => { ok: true; value: EditValue } | { ok: false; error: string },
    setError: (err: string | null) => void,
    resetToPristine: () => void,
  ) {
    fieldRegistryRef.current.set(columnName, { getValue, setError, resetToPristine });
  }

  function unregisterField(columnName: string) {
    fieldRegistryRef.current.delete(columnName);
  }

  function onApply() {
    // 1. Validate all touched fields.
    let hasError = false;
    const validatedValues = new Map<string, EditValue>();

    for (const colName of touchedColumns) {
      const reg = fieldRegistryRef.current.get(colName);
      if (!reg) continue;
      const result = reg.getValue();
      if (!result.ok) {
        reg.setError(result.error);
        hasError = true;
      } else {
        validatedValues.set(colName, result.value);
      }
    }

    if (hasError) return;

    // 2. Build entries and call bulkSetCellEdit.
    const entries: Array<{
      rowKey: string;
      column: string;
      value: EditValue;
      pk: Record<string, EditValue>;
      originalRow: CellValue[] | null;
      originalColumns: string[] | null;
    }> = [];

    for (const [colName, value] of validatedValues) {
      for (const row of eligibleRows) {
        entries.push({
          rowKey: row.rowKey,
          column: colName,
          value,
          pk: row.pk,
          originalRow: row.row,
          originalColumns: columns.map((c) => c.name),
        });
      }
    }

    buffer.bulkSetCellEdit(entries);

    // 3. Reset all touched fields (bump tick causes remount with updated row data).
    setTouchedColumns(new Set());
    setAppliedTick((t) => t + 1);
  }

  function onCancel() {
    // Reset every touched field to pristine without touching the buffer.
    for (const reg of fieldRegistryRef.current.values()) {
      reg.resetToPristine();
    }
    setTouchedColumns(new Set());
  }

  // No-PK in bulk: this can only happen when bulkEditAvailable === false but
  // selectedRows >= 2 and pkColumns === null. Since mode is "bulk" and requires
  // bulkEditAvailable, this guard handles the "no-PK + >=2 selections" case
  // which would arrive here if the caller sends bulkEditAvailable=false with
  // many rows. Guard defensively.
  const showNoPkBanner = pkColumns === null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        Inspector · {eligibleRows.length} rows selected
      </div>
      <div className={styles.body}>
        {showNoPkBanner ? (
          <div className={styles.bulkBanner}>
            Bulk edit unavailable on relations without a primary key
          </div>
        ) : (
          // Key includes selection identity + appliedTick so React remounts
          // all InspectorBulkField components when the selection changes or
          // after a successful apply (so fields re-initialize from new values).
          <BulkFieldList
            key={`${selectionKey}::${appliedTick}`}
            columns={columns}
            eligibleRows={eligibleRows}
            selectedRows={selectedRows}
            isReadOnly={isReadOnly}
            pkColumns={pkColumns!}
            enumValuesByColumn={enumValuesByColumn}
            touchedColumns={touchedColumns}
            onTouchedChange={handleTouchedChange}
            registerField={registerField}
            unregisterField={unregisterField}
          />
        )}
      </div>
      {!showNoPkBanner && bulkEditAvailable && !isReadOnly && (
        <div className={styles.bulkFooter}>
          <button
            type="button"
            className={styles.bulkCancelBtn}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.bulkApplyBtn}
            disabled={touchedCount === 0}
            onClick={onApply}
          >
            Apply to {eligibleRows.length} rows
          </button>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// BulkFieldList — renders per-column fields in bulk mode
// --------------------------------------------------------------------------
interface BulkFieldListProps {
  columns: DataColumn[];
  eligibleRows: SelectedRow[];
  selectedRows: SelectedRow[];
  isReadOnly: boolean;
  pkColumns: string[];
  enumValuesByColumn: Record<string, string[]>;
  touchedColumns: Set<string>;
  onTouchedChange(columnName: string, touched: boolean): void;
  registerField(
    columnName: string,
    getValue: () => { ok: true; value: EditValue } | { ok: false; error: string },
    setError: (err: string | null) => void,
    resetToPristine: () => void,
  ): void;
  unregisterField(columnName: string): void;
}

function BulkFieldList({
  columns,
  eligibleRows,
  isReadOnly,
  pkColumns,
  enumValuesByColumn,
  onTouchedChange,
  registerField,
  unregisterField,
}: BulkFieldListProps) {
  return (
    <>
      {columns.map((col, colIdx) => {
        const isPk = pkColumns.includes(col.name);
        const isBytea = looksLikeBytea(col.data_type);
        const hasEnvelope = eligibleRows.some((r) =>
          isCellEnvelope(r.row[colIdx]),
        );
        const bulkEditable = !isPk && !isBytea && !hasEnvelope && !isReadOnly;

        if (!bulkEditable) {
          // Read-only field: show a tooltip explaining why.
          const reason = isPk
            ? "Primary key — not editable"
            : isBytea
              ? "Binary column — not editable"
              : hasEnvelope
                ? "Cell envelope — not editable inline"
                : "Read-only connection";

          // Compute a common display value if all eligible rows share one.
          const first = eligibleRows[0]?.row[colIdx] ?? null;
          const allSame =
            eligibleRows.length > 0 &&
            eligibleRows.every((r) => {
              const v = r.row[colIdx] ?? null;
              return structurallyEqual(first, v as CellValue);
            });
          const commonValue = allSame ? first : null;
          const cat = categorize(col.data_type);

          return (
            <div key={col.name} className={styles.field}>
              <div className={styles.label}>
                <span>{col.name}</span>
                <span className={styles.type}>{col.data_type}</span>
              </div>
              <div title={reason}>
                {commonValue === null && !allSame ? (
                  <span className={styles.null} style={{ fontStyle: "italic" }}>
                    — multiple values —
                  </span>
                ) : commonValue === null ? (
                  <span className={styles.null}>NULL</span>
                ) : (
                  <div
                    className={`${styles.value} ${
                      isMonoCategory(cat) || cat === "json" || cat === "uuid"
                        ? styles.valueMono
                        : ""
                    }`}
                  >
                    {formatScalar(commonValue as CellValue)}
                  </div>
                )}
              </div>
            </div>
          );
        }

        return (
          <InspectorBulkField
            key={col.name}
            column={col}
            columnIndex={colIdx}
            eligibleRows={eligibleRows}
            enumValues={enumValuesByColumn[col.name]}
            onTouchedChange={onTouchedChange}
            registerRef={registerField}
            unregisterRef={unregisterField}
          />
        );
      })}
    </>
  );
}

// --------------------------------------------------------------------------
// InspectorBulkField — one column in bulk-edit mode
// --------------------------------------------------------------------------
function structurallyEqual(a: CellValue | EditValue, b: CellValue | EditValue): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function valueToText(value: CellValue | EditValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface InspectorBulkFieldProps {
  column: DataColumn;
  columnIndex: number;
  eligibleRows: Array<{ row: CellValue[] }>;
  enumValues?: string[];
  onTouchedChange(columnName: string, touched: boolean): void;
  registerRef(
    columnName: string,
    getValue: () => { ok: true; value: EditValue } | { ok: false; error: string },
    setError: (err: string | null) => void,
    resetToPristine: () => void,
  ): void;
  unregisterRef(columnName: string): void;
}

function InspectorBulkField({
  column,
  columnIndex,
  eligibleRows,
  enumValues,
  onTouchedChange,
  registerRef,
  unregisterRef,
}: InspectorBulkFieldProps) {
  // Compute the common value across all eligible rows (once on mount).
  const pristineValue = useMemo<CellValue | null>(() => {
    if (eligibleRows.length === 0) return null;
    const first = eligibleRows[0]!.row[columnIndex] ?? null;
    for (let i = 1; i < eligibleRows.length; i++) {
      const v = eligibleRows[i]!.row[columnIndex] ?? null;
      if (!structurallyEqual(first as CellValue, v as CellValue)) return null;
    }
    return first as CellValue;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // True when all rows agree (either a shared value or all null).
  const hasCommon = useMemo<boolean>(() => {
    if (eligibleRows.length === 0) return false;
    const first = eligibleRows[0]!.row[columnIndex] ?? null;
    return eligibleRows.every((r) => {
      const v = r.row[columnIndex] ?? null;
      return structurallyEqual(first as CellValue, v as CellValue);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pristineText = valueToText(pristineValue);

  const t = column.data_type.toLowerCase();
  const isJson = t === "json" || t === "jsonb" || t.endsWith("[]") || t.startsWith("_");
  const isBool = t === "boolean";
  const isEnum = (enumValues?.length ?? 0) > 0;
  const isNumeric = categorize(t) === "numeric";

  // State
  const [text, setText] = useState<string>(() => pristineText);
  const [isNull, setIsNull] = useState(false);
  const [touched, setTouched] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonWarning, setJsonWarning] = useState(false);

  // Internal ref for the pristine text (changes after Apply via remount).
  const pristineTextRef = useRef(pristineText);

  function markTouched(isTouched: boolean) {
    setTouched(isTouched);
    onTouchedChange(column.name, isTouched);
  }

  function resetToPristine() {
    setText(pristineTextRef.current);
    setIsNull(false);
    markTouched(false);
    setJsonError(null);
    setJsonWarning(false);
  }

  // Explicit NULL toggle for nullable free-form columns (text / numeric / JSON).
  // Gated on `is_nullable`; boolean/enum already expose NULL via their selects.
  const nullToggleButton = column.is_nullable ? (
    <button
      type="button"
      tabIndex={-1}
      title={isNull ? "Clear NULL" : "Set NULL"}
      className={`${styles.nullToggle} ${isNull ? styles.nullToggleActive : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (isNull) {
          setIsNull(false);
          markTouched(text !== pristineTextRef.current);
        } else {
          setIsNull(true);
          setJsonError(null);
          markTouched(true);
        }
      }}
    >
      NULL
    </button>
  ) : null;

  function getValue(): { ok: true; value: EditValue } | { ok: false; error: string } {
    if (isNull) return { ok: true, value: null };
    if (isBool) {
      if (text === "__noop__") return { ok: true, value: pristineValue as EditValue };
      if (text === "null") return { ok: true, value: null };
      return { ok: true, value: text === "true" };
    }
    if (isEnum) {
      if (text === "__noop__") return { ok: true, value: pristineValue as EditValue };
      return { ok: true, value: text === "" ? null : text };
    }
    if (isJson) {
      const result = validateJsonInput(text);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      setJsonWarning(hasSmartQuotes(result.canonical));
      return { ok: true, value: result.canonical === "" ? null : result.canonical };
    }
    if (isNumeric) {
      if (text.trim() === "") return { ok: true, value: null };
      const n = Number(text);
      return { ok: true, value: Number.isFinite(n) ? n : text };
    }
    // text / other
    return { ok: true, value: text === "" ? null : text };
  }

  // Register this field's imperative handles with the parent.
  useEffect(() => {
    registerRef(column.name, getValue, setJsonError, resetToPristine);
    return () => unregisterRef(column.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  const fieldClass = touched
    ? `${styles.field} ${styles.fieldTouched}`
    : styles.field;

  const touchedIndicator = touched ? (
    <span className={styles.touchedDot} aria-label="field touched">
      ●
    </span>
  ) : null;

  const revertButton = touched ? (
    <button
      type="button"
      className={styles.revertButton}
      title="Revert to original value"
      onClick={() => resetToPristine()}
    >
      <Undo2 size={11} />
    </button>
  ) : null;

  // Boolean field
  if (isBool) {
    const noopOption = !hasCommon ? "__noop__" : null;
    const currentBoolText = touched ? text : hasCommon ? (pristineValue === null ? "null" : pristineValue === true ? "true" : "false") : "__noop__";

    return (
      <div className={fieldClass}>
        <div className={styles.label}>
          <span>
            {column.name}
            {touchedIndicator}
          </span>
          <span className={styles.type}>{column.data_type}</span>
        </div>
        <div className={styles.bulkFieldRow}>
          <select
            className={styles.editor}
            value={touched ? text : (noopOption ?? currentBoolText)}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              const isPristine = noopOption === null
                ? v === (pristineValue === null ? "null" : pristineValue === true ? "true" : "false")
                : v === noopOption;
              markTouched(!isPristine);
            }}
          >
            {noopOption && <option value="__noop__">(no change)</option>}
            <option value="true">true</option>
            <option value="false">false</option>
            {column.is_nullable ? <option value="null">NULL</option> : null}
          </select>
          {revertButton}
        </div>
      </div>
    );
  }

  // Enum field
  if (isEnum && enumValues) {
    const noopOption = !hasCommon ? "__noop__" : null;
    const currentEnumText = touched ? text : hasCommon ? (typeof pristineValue === "string" ? pristineValue : "") : "__noop__";

    return (
      <div className={fieldClass}>
        <div className={styles.label}>
          <span>
            {column.name}
            {touchedIndicator}
          </span>
          <span className={styles.type}>{column.data_type}</span>
        </div>
        <div className={styles.bulkFieldRow}>
          <select
            className={styles.editor}
            value={touched ? text : (noopOption ?? currentEnumText)}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              const isPristine = noopOption === null
                ? v === (typeof pristineValue === "string" ? pristineValue : "")
                : v === noopOption;
              markTouched(!isPristine);
            }}
          >
            {noopOption && <option value="__noop__">(no change)</option>}
            {column.is_nullable ? <option value="">(NULL)</option> : null}
            {enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          {revertButton}
        </div>
      </div>
    );
  }

  // JSON / long-text field
  if (isJson || (typeof pristineValue === "string" && pristineValue.length > 100)) {
    const textareaClassName = [
      styles.editor,
      styles.editorMono,
      isJson && jsonError ? styles.jsonErrorBorder : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className={fieldClass}>
        <div className={styles.label}>
          <span>
            {column.name}
            {touchedIndicator}
          </span>
          <span className={styles.type}>{column.data_type}</span>
        </div>
        <div className={styles.bulkFieldRow}>
          <div className={styles.jsonEditorWrapper}>
            <textarea
              className={`${textareaClassName} ${isNull ? styles.editorNull : ""}`}
              value={isNull ? "" : text}
              placeholder={
                isNull ? "NULL" : hasCommon ? undefined : "— multiple values —"
              }
              rows={4}
              onChange={(e) => {
                const v = e.target.value;
                setText(v);
                setIsNull(false);
                setJsonError(null);
                setJsonWarning(false);
                markTouched(v !== pristineTextRef.current);
              }}
              {...noAutoCorrectProps}
            />
            {isJson && jsonError && (
              <div className={styles.jsonError}>{jsonError}</div>
            )}
            {isJson && jsonWarning && !jsonError && (
              <div className={styles.jsonWarning}>
                <AlertTriangle size={11} />
                Contains smart quotes
              </div>
            )}
          </div>
          {nullToggleButton}
          {revertButton}
        </div>
      </div>
    );
  }

  // Numeric / text field
  return (
    <div className={fieldClass}>
      <div className={styles.label}>
        <span>
          {column.name}
          {touchedIndicator}
        </span>
        <span className={styles.type}>{column.data_type}</span>
      </div>
      <div className={styles.bulkFieldRow}>
        <input
          type="text"
          className={`${styles.editor} ${
            isMonoCategory(categorize(t)) ? styles.editorMono : ""
          } ${isNull ? styles.editorNull : ""}`}
          inputMode={isNumeric ? "decimal" : undefined}
          value={isNull ? "" : text}
          placeholder={
            isNull ? "NULL" : hasCommon ? undefined : "— multiple values —"
          }
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            setIsNull(false);
            markTouched(v !== pristineTextRef.current);
          }}
          {...noAutoCorrectProps}
        />
        {nullToggleButton}
        {revertButton}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// InspectorEditableField — single-row editable field (unchanged from original)
// --------------------------------------------------------------------------
function InspectorEditableField({
  column,
  value,
  enumValues,
  onChange,
}: {
  column: DataColumn;
  value: CellValue | EditValue;
  enumValues?: string[];
  onChange(next: EditValue): void;
}) {
  const [text, setText] = useState<string>(() => valueToText(value));
  const [isNull, setIsNull] = useState<boolean>(value === null || value === undefined);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonWarning, setJsonWarning] = useState<boolean>(false);
  // Re-sync `text` when `value` changes from an external source (e.g. the
  // user edited the same cell in the grid). The `key` on this field already
  // covers cross-row remounts; this effect handles same-row external updates.
  const lastSyncedValueRef = useRef(value);
  useEffect(() => {
    if (!Object.is(value, lastSyncedValueRef.current)) {
      setText(valueToText(value));
      setIsNull(value === null || value === undefined);
      lastSyncedValueRef.current = value;
    }
  }, [value]);
  const t = column.data_type.toLowerCase();
  const isJson = t === "json" || t === "jsonb" || t.endsWith("[]") || t.startsWith("_");
  const isBool = t === "boolean";
  const isNumeric = categorize(t) === "numeric";

  // Commit the current `text` according to the column's type — used when the
  // user toggles NULL back off, restoring the previously typed value.
  function commitText() {
    if (isNumeric) {
      if (text.trim() === "") {
        onChange(null);
      } else {
        const n = Number(text);
        onChange(Number.isFinite(n) ? n : text);
      }
    } else {
      onChange(text);
    }
  }

  // Explicit NULL toggle for nullable free-form columns. Gated on
  // `is_nullable`; not rendered for boolean/enum columns (their selects already
  // expose a NULL choice). `onMouseDown` preventDefault keeps focus on the
  // field. Activating commits `null` immediately (single-row live-commit).
  const nullToggleButton = column.is_nullable ? (
    <button
      type="button"
      tabIndex={-1}
      title={isNull ? "Clear NULL" : "Set NULL"}
      className={`${styles.nullToggle} ${isNull ? styles.nullToggleActive : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (isNull) {
          setIsNull(false);
          commitText();
        } else {
          setIsNull(true);
          onChange(null);
        }
      }}
    >
      NULL
    </button>
  ) : null;

  if (isBool) {
    const cur = value === null ? "null" : value === true ? "true" : "false";
    return (
      <select
        className={styles.editor}
        value={cur}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "null" ? null : v === "true");
        }}
      >
        <option value="true">true</option>
        <option value="false">false</option>
        {column.is_nullable ? <option value="null">NULL</option> : null}
      </select>
    );
  }

  if (enumValues && enumValues.length > 0) {
    const cur = typeof value === "string" ? value : "";
    return (
      <select
        className={styles.editor}
        value={cur}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        {column.is_nullable ? <option value="">(NULL)</option> : null}
        {enumValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  if (isJson || (typeof value === "string" && value.length > 100)) {
    const textareaClassName = [
      styles.editor,
      styles.editorMono,
      isJson && jsonError ? styles.jsonErrorBorder : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className={styles.bulkFieldRow}>
        <div className={styles.jsonEditorWrapper}>
          <textarea
            className={`${textareaClassName} ${isNull ? styles.editorNull : ""}`}
            value={isNull ? "" : text}
            placeholder={isNull ? "NULL" : undefined}
            onChange={(e) => {
              const raw = e.target.value;
              setText(raw);
              setIsNull(false);
              setJsonError(null);
              setJsonWarning(false);
              onChange(raw);
            }}
            onBlur={() => {
              if (!isJson || isNull) return;
              const result = validateJsonInput(text);
              if (!result.ok) {
                setJsonError(result.error);
                setJsonWarning(false);
                return;
              }
              setJsonError(null);
              setJsonWarning(hasSmartQuotes(result.canonical));
            }}
            rows={4}
            {...noAutoCorrectProps}
          />
          {isJson && jsonError && (
            <div className={styles.jsonError}>{jsonError}</div>
          )}
          {isJson && jsonWarning && !jsonError && (
            <div className={styles.jsonWarning}>
              <AlertTriangle size={11} />
              Contains smart quotes
            </div>
          )}
        </div>
        {nullToggleButton}
      </div>
    );
  }

  return (
    <div className={styles.bulkFieldRow}>
      <input
        type="text"
        className={`${styles.editor} ${
          isMonoCategory(categorize(t)) ? styles.editorMono : ""
        } ${isNull ? styles.editorNull : ""}`}
        inputMode={isNumeric ? "decimal" : undefined}
        value={isNull ? "" : text}
        placeholder={isNull ? "NULL" : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          setIsNull(false);
          if (isNumeric) {
            if (raw.trim() === "") {
              onChange(null);
            } else {
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : raw);
            }
          } else {
            onChange(raw);
          }
        }}
        {...noAutoCorrectProps}
      />
      {nullToggleButton}
    </div>
  );
}
