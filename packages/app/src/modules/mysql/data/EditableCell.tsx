/**
 * MySQL EditableCell — per-column type-aware inline editor.
 *
 * Type dispatch based on column `data_type` / `column_type`:
 * - JSON → monospace textarea with JSON validator
 * - BLOB/VARBINARY/BINARY → binary indicator (not editable inline)
 * - GEOMETRY family → not editable in v1
 * - DATE/DATETIME/TIMESTAMP/TIME → ISO 8601 string input
 * - BOOLEAN/TINYINT(1) → checkbox (true/false/null trinary)
 * - ENUM → dropdown populated from column_type
 * - SET → multi-select checklist
 * - NULL toggle button (sets cell to null)
 * - All others → plain text input
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ColumnInfo } from "../types";
import type { CellValue, EditValue } from "./types";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function isJsonType(ct: string): boolean {
  return ct.toLowerCase() === "json";
}

function isBinaryType(ct: string): boolean {
  const l = ct.toLowerCase();
  return (
    l === "blob" || l === "tinyblob" || l === "mediumblob" || l === "longblob" ||
    l === "binary" || l.startsWith("varbinary")
  );
}

function isGeometryType(ct: string): boolean {
  const l = ct.toLowerCase();
  return (
    l === "geometry" || l === "point" || l === "linestring" || l === "polygon" ||
    l === "multipoint" || l === "multilinestring" || l === "multipolygon" ||
    l === "geometrycollection"
  );
}

function isDateTimeType(ct: string): boolean {
  const l = ct.toLowerCase();
  return l === "date" || l === "datetime" || l === "timestamp" || l === "time";
}

function isBooleanType(ct: string, colType: string): boolean {
  const l = ct.toLowerCase();
  const cl = colType.toLowerCase();
  return l === "boolean" || l === "bool" || cl === "tinyint(1)";
}

function isEnumType(colType: string): boolean {
  return colType.toLowerCase().startsWith("enum(");
}

function isSetType(colType: string): boolean {
  return colType.toLowerCase().startsWith("set(");
}

/** Parse `enum('a','b','c')` or `set('a','b','c')` → ['a', 'b', 'c'] */
function parseEnumMembers(colType: string): string[] {
  const m = colType.match(/^(?:enum|set)\((.+)\)$/i);
  if (!m) return [];
  const inner = m[1]!;
  const out: string[] = [];
  const regex = /'((?:[^'\\]|\\.)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(inner)) !== null) {
    out.push(match[1]!);
  }
  return out;
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
  const ct = column.column_type ?? "";

  // PK cells of existing rows are read-only.
  const blocked = isPkColumn && !isInsertRow;
  const canEdit = !isReadOnly && !blocked;

  if (!editing || !canEdit) {
    return (
      <DisplayCell
        value={value}
        dataType={dt}
        colType={ct}
        blocked={blocked && !isReadOnly}
        isGeometry={isGeometryType(dt)}
        isBinary={isBinaryType(dt)}
        onDoubleClick={canEdit ? onStartEdit : undefined}
      />
    );
  }

  // Dispatch to the appropriate editor
  if (isGeometryType(dt)) {
    return <DisplayCell value={value} dataType={dt} colType={ct} blocked={false} isGeometry isNotEditable onDoubleClick={undefined} />;
  }
  if (isBinaryType(dt) || isBinaryType(ct)) {
    return <DisplayCell value={value} dataType={dt} colType={ct} blocked={false} isBinary isNotEditable onDoubleClick={undefined} />;
  }
  if (isJsonType(dt)) {
    return (
      <JsonEditor
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isBooleanType(dt, ct)) {
    return (
      <BooleanEditor
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isEnumType(ct)) {
    const members = parseEnumMembers(ct);
    return (
      <EnumEditor
        members={members}
        initialValue={value}
        nullable={column.is_nullable}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isSetType(ct)) {
    const members = parseEnumMembers(ct);
    return (
      <SetEditor
        members={members}
        initialValue={value}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (isDateTimeType(dt)) {
    return (
      <DateTimeEditor
        dataType={dt}
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
  colType: string;
  blocked?: boolean;
  isGeometry?: boolean;
  isBinary?: boolean;
  isNotEditable?: boolean;
  onDoubleClick?(): void;
}

function DisplayCell({
  value,
  isGeometry,
  isBinary,
  isNotEditable,
  onDoubleClick,
}: DisplayCellProps) {
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
        title="not editable in v1"
        style={{ color: "var(--text-subtle)", fontStyle: "italic", fontSize: 11 }}
      >
        (geometry)
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
        {...noAutoCorrectProps}
      />
      {nullable && (
        <button
          type="button"
          title={isNull ? "Set value" : "Set NULL"}
          onClick={() => {
            setIsNull((n) => !n);
          }}
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
        {...noAutoCorrectProps}
      />
      {error && (
        <span style={{ fontSize: 10, color: "var(--danger)" }}>{error}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Boolean editor
// ---------------------------------------------------------------------------

interface BooleanEditorProps {
  initialValue: CellValue | EditValue;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function BooleanEditor({ initialValue, onCommit, onCancel }: BooleanEditorProps) {
  const trinary =
    initialValue === null ? "null" : initialValue ? "true" : "false";
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
// Enum editor
// ---------------------------------------------------------------------------

interface EnumEditorProps {
  members: string[];
  initialValue: CellValue | EditValue;
  nullable: boolean;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function EnumEditor({ members, initialValue, nullable, onCommit, onCancel }: EnumEditorProps) {
  const cur = initialValue === null ? "" : String(initialValue ?? "");
  return (
    <select
      value={cur}
      onChange={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
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
      {nullable && <option value="">NULL</option>}
      {members.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Set editor (multi-select checklist)
// ---------------------------------------------------------------------------

interface SetEditorProps {
  members: string[];
  initialValue: CellValue | EditValue;
  onCommit(v: EditValue): void;
  onCancel(): void;
}

function SetEditor({ members, initialValue, onCommit, onCancel }: SetEditorProps) {
  const parseSet = (v: CellValue | EditValue): string[] => {
    if (!v || v === "") return [];
    if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  };
  const [selected, setSelected] = useState<Set<string>>(
    new Set(parseSet(initialValue)),
  );

  function toggle(m: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  function commit() {
    const val = [...selected].join(",");
    onCommit(val === "" ? null : val);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: 4,
        border: "1px solid var(--accent)",
        borderRadius: 3,
        background: "var(--surface)",
        maxHeight: 120,
        overflow: "auto",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") commit();
      }}
    >
      {members.map((m) => (
        <label
          key={m}
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={selected.has(m)}
            onChange={() => toggle(m)}
          />
          {m}
        </label>
      ))}
      <button
        type="button"
        onClick={commit}
        style={{
          marginTop: 4,
          fontSize: 11,
          padding: "2px 6px",
          borderRadius: 3,
          border: "none",
          background: "var(--accent)",
          color: "var(--on-accent, #fff)",
          cursor: "pointer",
          alignSelf: "flex-end",
        }}
      >
        OK
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateTime editor
// ---------------------------------------------------------------------------

const DATE_PLACEHOLDER: Record<string, string> = {
  date: "YYYY-MM-DD",
  datetime: "YYYY-MM-DD HH:MM:SS",
  timestamp: "YYYY-MM-DD HH:MM:SS",
  time: "HH:MM:SS",
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
      {...noAutoCorrectProps}
    />
  );
}
