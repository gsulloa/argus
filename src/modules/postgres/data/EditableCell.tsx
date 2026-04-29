import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { categorize, isMonoCategory } from "./typeHelpers";
import { isCellEnvelope, type CellEnvelope, type CellValue, type DataColumn, type EditValue } from "./types";
import styles from "./DataGrid.module.css";

export interface EditableCellProps {
  column: DataColumn;
  /** Value to display: the buffer's dirty value if present, otherwise the server value. */
  displayValue: CellValue | EditValue;
  /** True when this cell has a pending edit in the buffer. */
  dirty: boolean;
  /** True when this cell cannot be edited (PK of existing row, bytea, envelope, read-only conn, no-PK relation). */
  readOnly: boolean;
  /** Enum labels for this column, if it's a Postgres enum type. */
  enumValues?: string[];
  /** Inline-edit mode is on when this cell is the active editor. */
  editing: boolean;
  onStartEdit(): void;
  onCommitEdit(value: EditValue): void;
  onCancelEdit(): void;
  style?: CSSProperties;
}

function formatEnvelope(env: CellEnvelope): string {
  const bytes = env.byte_length;
  const human =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return env.kind === "binary" ? `binary ~${human}` : `truncated ~${human}`;
}

function valueToInputString(v: CellValue | EditValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function looksLikeJson(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return t === "json" || t === "jsonb" || t.endsWith("[]") || t.startsWith("_");
}

function looksLikeBoolean(dataType: string): boolean {
  return dataType.toLowerCase() === "boolean";
}

function looksLikeNumeric(dataType: string): boolean {
  return categorize(dataType) === "numeric";
}

function looksLikeBytea(dataType: string): boolean {
  return dataType.toLowerCase() === "bytea";
}

/**
 * Coerce the raw input string into a typed `EditValue` based on the column's
 * data type. We keep this loose: anything ambiguous goes through as a string
 * and Postgres validates on commit.
 */
function parseInputValue(raw: string, column: DataColumn, isNull: boolean): EditValue {
  if (isNull) return null;
  const t = column.data_type.toLowerCase();
  if (looksLikeBoolean(t)) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null; // shouldn't happen given the select options, but be defensive
  }
  if (looksLikeNumeric(t)) {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (looksLikeJson(t)) {
    // Bind as the raw text — backend casts to json/jsonb.
    return raw;
  }
  return raw;
}

export function EditableCell(props: EditableCellProps) {
  const {
    column,
    displayValue,
    dirty,
    readOnly,
    enumValues,
    editing,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    style,
  } = props;

  // ----- Display path -----
  if (!editing) {
    const cls = [styles.cell, dirty ? styles.cellDirty : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        className={cls}
        style={style}
        onDoubleClick={() => {
          if (!readOnly) onStartEdit();
        }}
        title={
          readOnly
            ? looksLikeBytea(column.data_type)
              ? "binary, not editable inline"
              : isCellEnvelope(displayValue)
                ? "value too large to edit inline"
                : undefined
            : undefined
        }
      >
        <span className={styles.cellValue}>
          <DisplayContent value={displayValue} column={column} />
        </span>
      </div>
    );
  }

  // ----- Edit path -----
  return (
    <div className={`${styles.cell} ${styles.cellEditing}`} style={style}>
      <CellEditor
        column={column}
        initial={displayValue}
        enumValues={enumValues}
        onCommit={onCommitEdit}
        onCancel={onCancelEdit}
      />
    </div>
  );
}

function DisplayContent({
  value,
  column,
}: {
  value: CellValue | EditValue;
  column: DataColumn;
}) {
  if (value === null || value === undefined) {
    return <span className={styles.cellNull}>NULL</span>;
  }
  if (isCellEnvelope(value as CellValue)) {
    return <span className={styles.envelopeChip}>{formatEnvelope(value as CellEnvelope)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className={styles.cellMono}>{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className={styles.cellMono}>{String(value)}</span>;
  }
  if (typeof value === "string") {
    const cat = categorize(column.data_type);
    return (
      <span
        className={isMonoCategory(cat) ? styles.cellMono : undefined}
        title={value.length > 80 ? value : undefined}
      >
        {value}
      </span>
    );
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return (
    <span className={styles.cellMono} title={text.length > 80 ? text : undefined}>
      {text}
    </span>
  );
}

interface CellEditorProps {
  column: DataColumn;
  initial: CellValue | EditValue;
  enumValues?: string[];
  onCommit(value: EditValue): void;
  onCancel(): void;
}

function CellEditor({ column, initial, enumValues, onCommit, onCancel }: CellEditorProps) {
  const isNull = initial === null || initial === undefined;
  const [text, setText] = useState<string>(valueToInputString(initial));
  const [nullToggle, setNullToggle] = useState<boolean>(isNull);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const cur = inputRef.current;
    if (cur && (cur instanceof HTMLInputElement || cur instanceof HTMLTextAreaElement)) {
      cur.select();
    }
  }, []);

  function commit() {
    onCommit(parseInputValue(text, column, nullToggle));
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  }

  // Boolean → select with NULL option when nullable.
  if (looksLikeBoolean(column.data_type)) {
    const value = nullToggle ? "null" : text === "true" ? "true" : "false";
    return (
      <select
        ref={(el) => {
          inputRef.current = el;
        }}
        className={styles.cellEditor}
        value={value}
        onChange={(e) => {
          if (e.target.value === "null") {
            setNullToggle(true);
            setText("");
          } else {
            setNullToggle(false);
            setText(e.target.value);
          }
        }}
        onBlur={commit}
        onKeyDown={handleKey}
      >
        <option value="true">true</option>
        <option value="false">false</option>
        {column.is_nullable ? <option value="null">NULL</option> : null}
      </select>
    );
  }

  // Enum column → select with declared labels.
  if (enumValues && enumValues.length > 0) {
    const value = nullToggle ? "" : text;
    return (
      <select
        ref={(el) => {
          inputRef.current = el;
        }}
        className={styles.cellEditor}
        value={value}
        onChange={(e) => {
          setNullToggle(false);
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={handleKey}
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

  const t = column.data_type.toLowerCase();
  const useTextarea =
    looksLikeJson(t) || (typeof initial === "string" && initial.length > 100);

  if (useTextarea) {
    return (
      <textarea
        ref={(el) => {
          inputRef.current = el;
        }}
        className={`${styles.cellEditor} ${styles.cellEditorMono}`}
        value={text}
        onChange={(e) => {
          setNullToggle(false);
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={handleKey}
        rows={3}
      />
    );
  }

  return (
    <input
      ref={(el) => {
        inputRef.current = el;
      }}
      type="text"
      inputMode={looksLikeNumeric(t) ? "decimal" : undefined}
      className={`${styles.cellEditor} ${
        isMonoCategory(categorize(t)) ? styles.cellEditorMono : ""
      }`}
      value={text}
      onChange={(e) => {
        setNullToggle(false);
        setText(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={handleKey}
    />
  );
}

export { looksLikeBytea };
