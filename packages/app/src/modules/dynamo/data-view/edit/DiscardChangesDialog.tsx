/**
 * DiscardChangesDialog — task 11.2
 *
 * Thin confirmation dialog shown when the user attempts to navigate away
 * (tab close, tab switch, or row change) while a DynamoDB draft is unsaved.
 *
 * Portable: no Postgres-specific deps. Uses the same design tokens and button
 * style as the Postgres variant (DiscardChangesDialog.tsx) for consistency.
 */

import { useEffect, type CSSProperties } from "react";

export interface DiscardChangesDialogProps {
  /** Short description of the context — e.g. "close the tab" / "switch tabs". */
  context?: string;
  onCancel(): void;
  onDiscard(): void;
}

export function DiscardChangesDialog({
  context = "navigate away",
  onCancel,
  onDiscard,
}: DiscardChangesDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onDiscard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onDiscard]);

  return (
    <div
      style={backdropStyle}
      data-testid="discard-changes-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={dialogStyle} role="alertdialog" aria-modal="true" data-testid="discard-changes-dialog">
        <div style={headerStyle}>Discard changes?</div>
        <div style={bodyStyle}>
          You have unsaved edits. If you {context}, your changes will be lost.
        </div>
        <div style={footerStyle}>
          <button
            type="button"
            data-testid="discard-cancel-btn"
            style={btnStyle}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="discard-confirm-btn"
            style={{ ...btnStyle, ...btnDangerStyle }}
            onClick={onDiscard}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--bg-overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
};

const dialogStyle: CSSProperties = {
  width: 380,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  boxShadow: "var(--shadow-lg)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text)",
};

const bodyStyle: CSSProperties = {
  padding: "12px 16px",
  fontSize: 12,
  color: "var(--text-muted)",
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid var(--border)",
};

const btnStyle: CSSProperties = {
  fontSize: 12,
  padding: "5px 12px",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};

const btnDangerStyle: CSSProperties = {
  background: "var(--danger)",
  color: "#fff",
  borderColor: "var(--danger)",
};
