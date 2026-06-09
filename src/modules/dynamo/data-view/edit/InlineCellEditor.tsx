/**
 * InlineCellEditor — task 6.2
 *
 * Tag-aware inline editor for DynamoDB primitive cells.
 * Handles S / N / BOOL / NULL with keyboard and blur commit.
 *
 * DESIGN.md tokens:
 *   --accent for focus ring, --danger for error border,
 *   --bg-elevated for input bg, --border-strong for input border.
 *   Inputs: 6px 10px padding, 12-13px font, borderRadius 5.
 */

import { useEffect, useRef, useState } from "react";
import type { AttributeValue } from "../types";
import { noAutoCorrectProps } from "../../../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface InlineCellEditorProps {
  value: AttributeValue; // must be S / N / BOOL / NULL
  onCommit: (next: AttributeValue) => void;
  onCancel: () => void;
  saving: boolean;
}

// ---------------------------------------------------------------------------
// Spinner — a small CSS-animated circle
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <span
      data-testid="inline-spinner"
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        border: "1.5px solid var(--text-muted)",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "inline-editor-spin 0.7s linear infinite",
        flexShrink: 0,
        marginLeft: 4,
      }}
    />
  );
}

// Inject the keyframe once via a style tag (idempotent: same id, same rules).
if (typeof document !== "undefined") {
  const id = "__inline-editor-spin__";
  if (!document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `@keyframes inline-editor-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// Common input styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
  background: "var(--bg-elevated, var(--surface, #1e1e1e))",
  border: "1px solid var(--border-strong, #444)",
  borderRadius: 4,
  color: "var(--text)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  minWidth: 60,
};

const inputStyleFocus: React.CSSProperties = {
  ...inputStyle,
  boxShadow: "0 0 0 2px var(--accent, #a855f7)",
};

const inputStyleError: React.CSSProperties = {
  ...inputStyle,
  borderColor: "var(--danger, #ef4444)",
};

// ---------------------------------------------------------------------------
// S editor — single-line text
// ---------------------------------------------------------------------------

function SEditor({
  value,
  onCommit,
  onCancel,
  saving,
}: InlineCellEditorProps & { value: { S: string } }) {
  const [draft, setDraft] = useState(value.S);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  function commit() {
    onCommit({ S: draft });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <span style={{ display: "flex", alignItems: "center", width: "100%" }}>
      <input
        ref={inputRef}
        type="text"
        data-testid="inline-cell-input"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onFocus={() => setFocused(true)}
        style={focused ? inputStyleFocus : inputStyle}
        {...noAutoCorrectProps}
      />
      {saving && <Spinner />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// N editor — numeric text input with validation
// ---------------------------------------------------------------------------

function NEditor({
  value,
  onCommit,
  onCancel,
  saving,
}: InlineCellEditorProps & { value: { N: string } }) {
  const [draft, setDraft] = useState(value.N);
  const [invalid, setInvalid] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  function isValid(v: string): boolean {
    return v.trim() !== "" && Number.isFinite(Number(v.trim()));
  }

  function tryCommit() {
    if (!isValid(draft)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit({ N: draft.trim() });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      tryCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  const style = invalid
    ? inputStyleError
    : focused
      ? inputStyleFocus
      : inputStyle;

  return (
    <span style={{ display: "flex", alignItems: "center", width: "100%" }}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        data-testid="inline-cell-input"
        value={draft}
        disabled={saving}
        onChange={(e) => {
          setDraft(e.target.value);
          if (invalid) setInvalid(false); // clear error as user types
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setFocused(false);
          tryCommit();
        }}
        onFocus={() => setFocused(true)}
        style={style}
        {...noAutoCorrectProps}
      />
      {saving && <Spinner />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BOOL editor — toggle that commits immediately on flip
// ---------------------------------------------------------------------------

function BoolEditor({
  value,
  onCommit,
  saving,
}: InlineCellEditorProps & { value: { BOOL: boolean } }) {
  function toggle() {
    if (!saving) {
      onCommit({ BOOL: !value.BOOL });
    }
  }

  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: saving ? "default" : "pointer" }}
    >
      <button
        type="button"
        data-testid="inline-bool-toggle"
        disabled={saving}
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          fontSize: 12,
          fontFamily: "var(--font-mono, monospace)",
          background: "var(--bg-elevated, var(--surface, #1e1e1e))",
          border: "1px solid var(--border-strong, #444)",
          borderRadius: 4,
          color: value.BOOL ? "var(--success, #4ade80)" : "var(--text-muted)",
          cursor: saving ? "default" : "pointer",
        }}
      >
        {value.BOOL ? "true" : "false"}
      </button>
      {saving && <Spinner />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// NULL editor — segmented "Set to NULL" / "Set to value" control
// ---------------------------------------------------------------------------

function NullEditor({
  onCommit,
  onCancel,
  saving,
}: InlineCellEditorProps) {
  const segStyle = (active: boolean): React.CSSProperties => ({
    padding: "2px 8px",
    fontSize: 11,
    fontFamily: "var(--font-mono, monospace)",
    background: active ? "var(--accent-soft, rgba(168,85,247,0.15))" : "var(--bg-elevated, var(--surface, #1e1e1e))",
    border: "1px solid var(--border-strong, #444)",
    color: active ? "var(--accent, #a855f7)" : "var(--text-muted)",
    cursor: saving ? "default" : "pointer",
    borderRadius: 4,
  });

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {/* "Set to NULL" keeps NULL — commits the value as-is */}
      <button
        type="button"
        data-testid="inline-null-set-null"
        disabled={saving}
        onClick={() => { if (!saving) onCommit({ NULL: true }); }}
        style={segStyle(true)}
      >
        null
      </button>
      {/* "Set to value" exits the inline editor — type change is via inspector */}
      <button
        type="button"
        data-testid="inline-null-set-value"
        disabled={saving}
        onClick={() => { if (!saving) onCancel(); }}
        style={segStyle(false)}
      >
        set value
      </button>
      {saving && <Spinner />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// InlineCellEditor — public component
// ---------------------------------------------------------------------------

export function InlineCellEditor(props: InlineCellEditorProps) {
  const { value } = props;

  if ("S" in value) {
    return <SEditor {...props} value={value} />;
  }
  if ("N" in value) {
    return <NEditor {...props} value={value} />;
  }
  if ("BOOL" in value) {
    return <BoolEditor {...props} value={value} />;
  }
  if ("NULL" in value) {
    return <NullEditor {...props} />;
  }

  // Fallback — should not happen for primitive-only callers
  return null;
}
