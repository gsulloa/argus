import { useEffect, useRef, useState } from "react";
import { isCellEnvelope, type CellEnvelope, type CellValue, type DataColumn, type EditValue } from "./types";
import { categorize, isMonoCategory } from "./typeHelpers";
import type { UseEditBufferResult } from "./useEditBuffer";
import { looksLikeBytea } from "./EditableCell";
import styles from "./Inspector.module.css";

interface Props {
  columns: DataColumn[];
  row: CellValue[] | null;
  /** Stable key for the selected row; needed to look up edits in the buffer. */
  rowKey: string | null;
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

export function Inspector({
  columns,
  row,
  rowKey,
  isReadOnly,
  pkColumns,
  enumValuesByColumn,
  buffer,
}: Props) {
  if (!row) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>Inspector</div>
        <div className={styles.empty}>Select a row to inspect.</div>
      </div>
    );
  }
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
                  {dirty ? <span className={styles.dirtyDot} aria-label="dirty">●</span> : null}
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
  // Re-sync `text` when `value` changes from an external source (e.g. the
  // user edited the same cell in the grid). The `key` on this field already
  // covers cross-row remounts; this effect handles same-row external updates.
  const lastSyncedValueRef = useRef(value);
  useEffect(() => {
    if (!Object.is(value, lastSyncedValueRef.current)) {
      setText(valueToText(value));
      lastSyncedValueRef.current = value;
    }
  }, [value]);
  const t = column.data_type.toLowerCase();
  const isJson = t === "json" || t === "jsonb" || t.endsWith("[]") || t.startsWith("_");
  const isBool = t === "boolean";
  const isNumeric = categorize(t) === "numeric";

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
    return (
      <textarea
        className={`${styles.editor} ${styles.editorMono}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(text)}
        rows={4}
      />
    );
  }

  return (
    <input
      type="text"
      className={`${styles.editor} ${
        isMonoCategory(categorize(t)) ? styles.editorMono : ""
      }`}
      inputMode={isNumeric ? "decimal" : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
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
      }}
    />
  );
}
