/**
 * MSSQL Inspector pane — right-side panel showing the focused cell's full value
 * and metadata: truncation info, parsed JSON tree for JSON columns,
 * base64 view for binary columns, XML monospace view.
 * MSSQL deltas vs MySQL: IDENTITY / computed / rowversion read-only tags.
 *
 * §18.6
 */

import { useMemo } from "react";
import type { ColumnInfo } from "../types";
import type { CellValue, EditValue, CellEnvelope } from "./types";
import { isCellEnvelope } from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface InspectorSelectedRow {
  rowKey: string;
  row: CellValue[];
  pk: Record<string, EditValue>;
  source: "insert" | "server";
  isDeleted: boolean;
}

interface Props {
  columns: ColumnInfo[];
  selectedRows: InspectorSelectedRow[];
  isReadOnly: boolean;
  pkColumns: string[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatValue(v: CellValue | EditValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function isJsonType(dataType: string): boolean {
  return dataType.toLowerCase() === "json";
}

function isXmlType(dataType: string): boolean {
  return dataType.toLowerCase() === "xml";
}

function isBinaryType(dataType: string): boolean {
  const l = dataType.toLowerCase();
  return (
    l === "binary" || l === "varbinary" || l === "image" ||
    l === "rowversion" || l === "timestamp"
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function JsonTree({ value }: { value: CellValue | EditValue }) {
  const formatted = useMemo(() => {
    try {
      const parsed =
        typeof value === "string" ? JSON.parse(value) : value;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(value ?? "");
    }
  }, [value]);

  return (
    <pre
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono, monospace)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        margin: 0,
        padding: "4px 6px",
        background: "var(--bg-sidebar)",
        borderRadius: 3,
        border: "1px solid var(--border)",
        maxHeight: 200,
        overflow: "auto",
        color: "var(--text)",
      }}
    >
      {formatted}
    </pre>
  );
}

function XmlView({ value }: { value: string | CellValue | EditValue }) {
  return (
    <pre
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono, monospace)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        margin: 0,
        padding: "4px 6px",
        background: "var(--bg-sidebar)",
        borderRadius: 3,
        border: "1px solid var(--border)",
        maxHeight: 200,
        overflow: "auto",
        color: "var(--text)",
      }}
    >
      {String(value ?? "")}
    </pre>
  );
}

function EnvelopeView({ envelope }: { envelope: CellEnvelope }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginBottom: 4,
        }}
      >
        {envelope.kind === "binary" ? "binary" : "truncated"} ~{humanBytes(envelope.byte_length)}
      </div>
      {envelope.kind === "binary" && (
        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--bg-active)",
              color: "var(--text-muted)",
              letterSpacing: "0.04em",
            }}
          >
            base64
          </span>
        </div>
      )}
      <pre
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono, monospace)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: 0,
          padding: "4px 6px",
          background: "var(--bg-sidebar)",
          borderRadius: 3,
          border: "1px solid var(--border)",
          maxHeight: 120,
          overflow: "auto",
          color: "var(--text-subtle)",
        }}
      >
        {envelope.preview}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Inspector
// ---------------------------------------------------------------------------

export function Inspector({ columns, selectedRows, isReadOnly, pkColumns }: Props) {
  // Focus the first non-deleted row in the selection.
  const focusedRow = useMemo(
    () => selectedRows.find((r) => !r.isDeleted) ?? selectedRows[0] ?? null,
    [selectedRows],
  );

  if (!focusedRow) {
    return (
      <div style={containerStyle}>
        <div style={emptyStyle}>Select a cell to inspect</div>
      </div>
    );
  }

  const row = focusedRow.row;

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>Inspector</div>
      {isReadOnly && (
        <div style={{ ...tagStyle, marginBottom: 6, background: "var(--bg-active)" }}>
          Read-only connection
        </div>
      )}
      {columns.map((col, idx) => {
        const rawVal = row[idx] ?? null;
        const isPk = pkColumns?.includes(col.name) ?? false;
        const isJson = isJsonType(col.data_type);
        const isXml = isXmlType(col.data_type);
        const isBin = isBinaryType(col.data_type);
        const isEnvelope = isCellEnvelope(rawVal);

        return (
          <div key={col.name} style={fieldStyle}>
            <div style={fieldHeaderStyle}>
              <span style={fieldNameStyle}>{col.name}</span>
              <span style={fieldTypeStyle}>{col.data_type}</span>
              {isPk && <span style={tagStyle}>PK</span>}
              {col.is_identity && <span style={tagStyle}>IDENTITY</span>}
              {col.is_computed && <span style={tagStyle}>COMPUTED</span>}
              {isBin && !col.is_identity && !col.is_computed && (
                <span style={tagStyle}>binary</span>
              )}
            </div>
            <div style={fieldValueStyle}>
              {isEnvelope ? (
                <EnvelopeView envelope={rawVal as CellEnvelope} />
              ) : isJson && rawVal !== null ? (
                <JsonTree value={rawVal} />
              ) : isXml && rawVal !== null ? (
                <XmlView value={rawVal} />
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    wordBreak: "break-all",
                    color: rawVal === null ? "var(--text-subtle)" : "var(--text)",
                    fontStyle: rawVal === null ? "italic" : "normal",
                    fontFamily:
                      isBin || isXml ? "var(--font-mono, monospace)" : "inherit",
                  }}
                >
                  {formatValue(rawVal)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 0,
  overflow: "auto",
  height: "100%",
  background: "var(--bg-sidebar)",
  borderLeft: "1px solid var(--border)",
  flex: "0 0 320px",
  width: 320,
};

const headerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-subtle)",
  padding: "6px 10px",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const emptyStyle: React.CSSProperties = {
  padding: "12px 10px",
  fontSize: 12,
  color: "var(--text-subtle)",
  fontStyle: "italic",
};

const fieldStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--border)",
};

const fieldHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginBottom: 3,
};

const fieldNameStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text)",
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

const fieldTypeStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-subtle)",
  fontVariantNumeric: "tabular-nums",
};

const tagStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: "0.04em",
  padding: "1px 4px",
  borderRadius: 3,
  background: "var(--bg-active)",
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
};

const fieldValueStyle: React.CSSProperties = {
  fontSize: 12,
};
