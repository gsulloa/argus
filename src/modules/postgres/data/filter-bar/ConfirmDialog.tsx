import { useEffect, type CSSProperties } from "react";

interface Props {
  title: string;
  message: string;
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * Plain confirm dialog shared by mode-toggle flows. Cancel is the default
 * action (Esc / Enter both trigger Cancel — the user has to click Confirm
 * deliberately).
 */
export function ConfirmDialog({
  title,
  message,
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  destructive,
  onCancel,
  onConfirm,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={dialogStyle} role="alertdialog" aria-modal="true" aria-label={title}>
        <div style={headerStyle}>{title}</div>
        <div style={bodyStyle}>{message}</div>
        <div style={footerStyle}>
          <button type="button" style={btnStyle} onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            style={{
              ...btnStyle,
              ...(destructive ? btnDangerStyle : btnPrimaryStyle),
            }}
            onClick={onConfirm}
          >
            {confirmLabel}
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

const btnDangerStyle: CSSProperties = {
  background: "var(--danger)",
  color: "white",
  borderColor: "var(--danger)",
};
