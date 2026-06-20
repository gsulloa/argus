import { useEffect, type CSSProperties } from "react";

export interface DiscardChangesDialogProps {
  count: number;
  onCancel(): void;
  onDiscard(): void;
  /** Controls header and body copy. Defaults to "close". */
  action?: "close" | "refresh" | "discard";
}

export function DiscardChangesDialog({ count, onCancel, onDiscard, action = "close" }: DiscardChangesDialogProps) {
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

  const plural = count === 1 ? "" : "s";
  const header =
    action === "refresh"
      ? `Discard ${count} change${plural} and refresh?`
      : `Discard ${count} change${plural}?`;

  const body =
    action === "refresh"
      ? "Refreshing the table will lose your pending edits. They have not been committed to the database."
      : action === "discard"
      ? "Your pending edits have not been committed to the database."
      : "Closing this tab will lose your pending edits. They have not been committed to the database.";

  return (
    <div
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={dialogStyle} role="alertdialog" aria-modal="true">
        <div style={headerStyle}>
          {header}
        </div>
        <div style={bodyStyle}>
          {body}
        </div>
        <div style={footerStyle}>
          <button type="button" style={btnStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...btnStyle, ...btnPrimaryStyle }}
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
  zIndex: 100,
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

const btnPrimaryStyle: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-text)",
  borderColor: "var(--accent)",
};
