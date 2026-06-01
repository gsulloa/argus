/**
 * MSSQL EditableCell — per-column type-aware inline editor.
 *
 * Type dispatch based on column `data_type` / `base_type`:
 * - JSON → monospace textarea with JSON validator
 * - Binary / VarBinary / Image / RowVersion → base64 helper, read-only with badge for rowversion
 * - Datetime / Datetime2 / SmallDatetime / Date / Time / DatetimeOffset → ISO 8601 helper
 * - UniqueIdentifier → canonical UUID input (lowercase hyphenated)
 * - IDENTITY columns → read-only with badge "IDENTITY"
 * - Computed columns → read-only with badge "Computed"
 * - RowVersion → read-only with badge "RowVersion"
 * - XML → monospace text editor
 * - BIT → checkbox (true/false/null trinary)
 * - NULL toggle: check-box style
 * - All others → plain text input
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ColumnInfo } from "../types";
import type { CellValue, EditValue } from "./types";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function isJsonType(dt: string): boolean {
  return dt.toLowerCase() === "json";
}

function isXmlType(dt: string): boolean {
  return dt.toLowerCase() === "xml";
}

function isBinaryType(dt: string): boolean {
  const l = dt.toLowerCase();
  return (
    l === "binary" ||
    l.startsWith("varbinary") ||
    l === "image" ||
    l === "rowversion" ||
    l === "timestamp"
  );
}

function isRowVersionType(dt: string): boolean {
  const l = dt.toLowerCase();
  return l === "rowversion" || l === "timestamp";
}

function isDateTimeType(dt: string): boolean {
  const l = dt.toLowerCase();
  return (
    l === "date" ||
    l === "datetime" ||
    l === "datetime2" ||
    l === "smalldatetime" ||
    l === "time" ||
    l === "datetimeoffset"
  );
}

function isUuidType(dt: string): boolean {
  return dt.toLowerCase() === "uniqueidentifier";
}

function isBitType(dt: string): boolean {
  return dt.toLowerCase() === "bit";
}

function isGeometryType(dt: string): boolean {
  const l = dt.toLowerCase();
  return (
    l === "geometry" || l === "geography" || l === "hierarchyid" || l === "sql_variant"
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  column: ColumnInfo;
  value: CellValue | EditValue;
  isPkColumn: boolean;
  isReadOnly: boolean;
  isInsertRow?: boolean;
  onCommit(value: EditValue): void;
  onCancel(): void;
  /** If true, renders display mode. If false, renders edit mode (inline editor). */
  editing: boolean;
  onStartEdit(): void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditableCell({
  column,
  value,
  isPkColumn,
  isReadOnly,
  isInsertRow,
  onCommit,
  onCancel,
  editing,
  onStartEdit,
}: Props) {
  const dt = column.data_type ?? "";
  const bt = column.base_type ?? dt;

  // IDENTITY columns of existing rows are read-only; hide on insert rows.
  const isIdentity = column.is_identity;
  const isComputed = column.is_computed;
  const isRowVersion = isRowVersionType(dt) || isRowVersionType(bt);

  // PK cells of existing rows are read-only.
  const isSystemReadOnly = isIdentity || isComputed || isRowVersion;
  const blocked = (isPkColumn && !isInsertRow) || isSystemReadOnly;
  const canEdit = !isReadOnly && !blocked;

  // Badge for system-managed columns
  let badge: string | null = null;
  if (isIdentity && !isInsertRow) badge = "IDENTITY";
  else if (isComputed) badge = "Computed";
  else if (isRowVersion) badge = "RowVersion";

  if (!editing || !canEdit) {
    return (
      <DisplayCell
        value={value}
        dataType={dt}
        baseType={bt}
        blocked={blocked && !isReadOnly}
        badge={badge}
        isBinary={isBinaryType(dt) || isBinaryType(bt)}
        isGeometry={isGeometryType(dt) || isGeometryType(bt)}
        onDoubleClick={canEdit ? onStartEdit : undefined}
      />
    );
  }

  // Dispatch to the appropriate editor
  if (isGeometryType(dt) || isGeometryType(bt)) {
    return (
      <DisplayCell
        value={value}
        dataType={dt}
        baseType={bt}
        blocked={false}
        badge={null}
        isGeometry
        isNotEditable
        onDoubleClick={undefined}
      />
    );
  }
  if (isBinaryType(dt) || isBinaryType(bt)) {
    return (
      <DisplayCell
        value={value}
        dataType={dt}
        baseType={bt}
        blocked={false}
        badge={null}
        isBinary
        isNotEditable
        onDoubleClick={undefined}
      />
    );
  }
  if (isJsonType(dt) || isJsonType(bt)) {
    return (
      <JsonEditor
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isXmlType(dt) || isXmlType(bt)) {
    return (
      <XmlEditor
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isBitType(dt) || isBitType(bt)) {
    return (
      <BooleanEditor
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isUuidType(dt) || isUuidType(bt)) {
    return (
      <UuidEditor
        initialValue={value}
        nullable={column.is_nullable}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isDateTimeType(dt) || isDateTimeType(bt)) {
    return (
      <DateTimeEditor
        dataType={dt || bt}
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }

  // Default: plain text
  return (
    <TextEditor
      initialValue={value}
      nullable={column.is_nullable}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

// ---------------------------------------------------------------------------
// Display cell
// ---------------------------------------------------------------------------

interface DisplayCellProps {
  value: CellValue | EditValue;
  dataType: string;
  baseType: string;
  blocked?: boolean;
  badge?: string | null;
  isGeometry?: boolean;
  isBinary?: boolean;
  isNotEditable?: boolean;
  onDoubleClick?(): void;
}

function DisplayCell({
  value,
  badge,
  isGeometry,
  isBinary,
  isNotEditable,
  onDoubleClick,
}: DisplayCellProps) {
  if (badge) {
    return (
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          padding: "1px 4px",
          borderRadius: 3,
          background: "var(--bg-active)",
          color: "var(--text-muted)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          userSelect: "none",
        }}
      >
        {badge}
      </span>
    );
  }
  if (isNotEditable && isBinary) {
    return (
      <span
        title="binary, not editable inline"
        style={{ color: "var(--text-subtle)", fontStyle: "italic", fontSize: 11 }}
      >
        (binary)
      </span>
    );
  }
  if (isNotEditable && isGeometry) {
    return (
      <span
        title="spatial/hierarchyid/sql_variant — not editable in v1"
        style={{ color: "var(--text-subtle)", fontStyle: "italic", fontSize: 11 }}
      >
        (spatial)
      </span>
    );
  }
  const displayStr = valueToDisplay(value);
  return (
    <span
      onDoubleClick={onDoubleClick}
      style={{ cursor: onDoubleClick ? "text" : "default", userSelect: "text" }}
      title={displayStr}
    >
      {displayStr}
    </span>
  );
}

function valueToDisplay(v: CellValue | EditValue): string {
  if (v === null) return "NULL";
  if (v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.kind === "binary" && typeof o.preview === "string") {
      return `[binary ${o.byte_length}B]`;
    }
    if (o.kind === "truncated" && typeof o.preview === "string") {
      return `${o.preview}… [truncated]`;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Text editor
// ---------------------------------------------------------------------------

interface TextEditorProps {
  initialValue: CellValue | EditValue;
  nullable: boolean;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function TextEditor({ initialValue, nullable, onCommit, onCancel }: TextEditorProps) {
  const [val, setVal] = useState(
    initialValue === null ? "" : String(initialValue ?? ""),
  );
  const [isNull, setIsNull] = useState(initialValue === null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onCommit(isNull ? null : val);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <input
        ref={inputRef}
        type="text"
        value={isNull ? "" : val}
        disabled={isNull}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => onCommit(isNull ? null : val)}
        style={{
          fontSize: 12,
          padding: "1px 4px",
          border: "1px solid var(--accent)",
          borderRadius: 3,
          outline: "none",
          background: "var(--surface)",
          color: isNull ? "var(--text-subtle)" : "var(--text)",
          flex: 1,
          minWidth: 0,
        }}
        autoFocus
      />
      {nullable && (
        <button
          type="button"
          title={isNull ? "Set value" : "Set NULL"}
          onClick={() => setIsNull((n) => !n)}
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 4px",
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: isNull ? "var(--accent)" : "transparent",
            color: isNull ? "var(--on-accent, #fff)" : "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          NULL
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON editor
// ---------------------------------------------------------------------------

interface JsonEditorProps {
  initialValue: CellValue | EditValue;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function JsonEditor({ initialValue, onCommit, onCancel }: JsonEditorProps) {
  const [raw, setRaw] = useState(
    initialValue === null
      ? "null"
      : typeof initialValue === "string"
      ? initialValue
      : JSON.stringify(initialValue, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.select();
  }, []);

  function validate(text: string): boolean {
    try {
      JSON.parse(text);
      setError(null);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  function commit() {
    if (!validate(raw)) return;
    try {
      onCommit(JSON.parse(raw));
    } catch {
      // already validated
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <textarea
        ref={textareaRef}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          validate(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        autoFocus
        rows={4}
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono, monospace)",
          padding: "4px 6px",
          border: `1px solid ${error ? "var(--danger)" : "var(--accent)"}`,
          borderRadius: 3,
          outline: "none",
          background: "var(--surface)",
          color: "var(--text)",
          resize: "vertical",
        }}
      />
      {error && (
        <span style={{ fontSize: 10, color: "var(--danger)" }}>{error}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// XML editor
// ---------------------------------------------------------------------------

function XmlEditor({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: CellValue | EditValue;
  onCommit(v: EditValue): void;
  onCancel(): void;
}) {
  const [raw, setRaw] = useState(
    initialValue === null ? "" : String(initialValue ?? ""),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.select();
  }, []);

  return (
    <textarea
      ref={textareaRef}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit(raw === "" ? null : raw);
        }
      }}
      onBlur={() => onCommit(raw === "" ? null : raw)}
      autoFocus
      rows={4}
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono, monospace)",
        padding: "4px 6px",
        border: "1px solid var(--accent)",
        borderRadius: 3,
        outline: "none",
        background: "var(--surface)",
        color: "var(--text)",
        resize: "vertical",
        width: "100%",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Boolean (BIT) editor
// ---------------------------------------------------------------------------

interface BooleanEditorProps {
  initialValue: CellValue | EditValue;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function BooleanEditor({ initialValue, onCommit, onCancel }: BooleanEditorProps) {
  const trinary =
    initialValue === null ? "null" : (initialValue as boolean) ? "true" : "false";
  const [val, setVal] = useState(trinary);

  const handleChange = useCallback(
    (next: string) => {
      setVal(next);
      if (next === "null") onCommit(null);
      else if (next === "true") onCommit(true);
      else onCommit(false);
    },
    [onCommit],
  );

  return (
    <select
      value={val}
      onChange={(e) => handleChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(val === "null" ? null : val === "true")}
      autoFocus
      style={{
        fontSize: 12,
        padding: "1px 4px",
        border: "1px solid var(--accent)",
        borderRadius: 3,
        outline: "none",
        background: "var(--surface)",
        color: "var(--text)",
      }}
    >
      <option value="true">true</option>
      <option value="false">false</option>
      <option value="null">NULL</option>
    </select>
  );
}

// ---------------------------------------------------------------------------
// UUID / UNIQUEIDENTIFIER editor
// ---------------------------------------------------------------------------

interface UuidEditorProps {
  initialValue: CellValue | EditValue;
  nullable: boolean;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function UuidEditor({ initialValue, nullable, onCommit, onCancel }: UuidEditorProps) {
  const [val, setVal] = useState(
    initialValue === null ? "" : String(initialValue ?? ""),
  );
  const [isNull, setIsNull] = useState(initialValue === null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  /** Canonicalize UUID to lowercase hyphenated form */
  function canonicalize(v: string): string {
    const stripped = v.replace(/[^0-9a-fA-F]/g, "");
    if (stripped.length === 32) {
      return [
        stripped.slice(0, 8),
        stripped.slice(8, 12),
        stripped.slice(12, 16),
        stripped.slice(16, 20),
        stripped.slice(20),
      ]
        .join("-")
        .toLowerCase();
    }
    return v.toLowerCase();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onCommit(isNull ? null : canonicalize(val));
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <input
        ref={inputRef}
        type="text"
        value={isNull ? "" : val}
        disabled={isNull}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => onCommit(isNull ? null : canonicalize(val))}
        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        style={{
          fontSize: 12,
          padding: "1px 4px",
          border: "1px solid var(--accent)",
          borderRadius: 3,
          outline: "none",
          background: "var(--surface)",
          color: isNull ? "var(--text-subtle)" : "var(--text)",
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono, monospace)",
        }}
        autoFocus
      />
      {nullable && (
        <button
          type="button"
          title={isNull ? "Set value" : "Set NULL"}
          onClick={() => setIsNull((n) => !n)}
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 4px",
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: isNull ? "var(--accent)" : "transparent",
            color: isNull ? "var(--on-accent, #fff)" : "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          NULL
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateTime editor
// ---------------------------------------------------------------------------

const DATE_PLACEHOLDER: Record<string, string> = {
  date: "YYYY-MM-DD",
  datetime: "YYYY-MM-DD HH:MM:SS",
  datetime2: "YYYY-MM-DD HH:MM:SS[.fffffff]",
  smalldatetime: "YYYY-MM-DD HH:MM",
  time: "HH:MM:SS[.fffffff]",
  datetimeoffset: "YYYY-MM-DD HH:MM:SS[.fffffff] ±HH:MM",
};

interface DateTimeEditorProps {
  dataType: string;
  initialValue: CellValue | EditValue;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function DateTimeEditor({ dataType, initialValue, onCommit, onCancel }: DateTimeEditorProps) {
  const [val, setVal] = useState(
    initialValue === null ? "" : String(initialValue ?? ""),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const placeholder = DATE_PLACEHOLDER[dataType.toLowerCase()] ?? "ISO 8601";

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          onCommit(val === "" ? null : val);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(val === "" ? null : val)}
      placeholder={placeholder}
      autoFocus
      style={{
        fontSize: 12,
        padding: "1px 4px",
        border: "1px solid var(--accent)",
        borderRadius: 3,
        outline: "none",
        background: "var(--surface)",
        color: "var(--text)",
        width: "100%",
      }}
    />
  );
}
