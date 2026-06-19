/**
 * OptimisticLockingDialog — task 10.2
 *
 * Modal dialog to configure the version attribute for optimistic locking.
 * Reachable from the toolbar "Locking…" button.
 *
 * Design tokens: --bg-elevated, --border-strong, --accent, --text-muted.
 * Buttons: 6px 12px, 12-13px font, borderRadius 5.
 */

import { useState } from "react";
import { noAutoCorrectProps } from "../../../shared/text-input-hygiene";
import { APP_DISPLAY_NAME } from "@/platform/app-identity";

export interface OptimisticLockingDialogProps {
  open: boolean;
  versionAttr: string;
  onChange: (next: string) => void;
  onClose: () => void;
}

export function OptimisticLockingDialog({
  open,
  versionAttr,
  onChange,
  onClose,
}: OptimisticLockingDialogProps) {
  const [localValue, setLocalValue] = useState(versionAttr);

  // Sync local value when dialog re-opens with different external value
  // (pattern: use key on the outer element to re-mount on open)

  if (!open) return null;

  function handleSave() {
    onChange(localValue.trim());
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") onClose();
  }

  return (
    // Backdrop
    <div
      data-testid="optimistic-locking-dialog-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg-overlay, rgba(0,0,0,0.6))",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog panel */}
      <div
        data-testid="optimistic-locking-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="opt-lock-title"
        style={{
          background: "var(--bg-elevated, #18181f)",
          border: "1px solid var(--border-strong, #2e2f3a)",
          borderRadius: 12,
          padding: "20px 24px",
          minWidth: 380,
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          fontFamily: "var(--font-sans, system-ui)",
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div>
          <h3
            id="opt-lock-title"
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text, #e2e2e9)",
            }}
          >
            Optimistic locking
          </h3>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label
            htmlFor="version-attr-input"
            style={{
              fontSize: 12,
              color: "var(--text-muted, #888)",
              fontWeight: 500,
            }}
          >
            Version attribute name
          </label>
          <input
            id="version-attr-input"
            data-testid="version-attr-input"
            type="text"
            {...noAutoCorrectProps}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            placeholder="e.g. version"
            autoFocus
            style={{
              padding: "6px 10px",
              fontSize: 13,
              fontFamily: "inherit",
              background: "var(--bg, #0b0b0f)",
              border: "1px solid var(--border-strong, #2e2f3a)",
              borderRadius: 5,
              color: "var(--text, #e2e2e9)",
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
          <p
            style={{
              margin: 0,
              fontSize: 11,
              color: "var(--text-muted, #888)",
              lineHeight: 1.5,
            }}
          >
            When this is set AND the &ldquo;Use ConditionExpression on update&rdquo; toggle is on,
            {" "}
            {APP_DISPLAY_NAME} appends{" "}
            <code
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 10,
                background: "rgba(255,255,255,0.06)",
                padding: "1px 4px",
                borderRadius: 3,
              }}
            >
              attribute_exists(&lt;pk&gt;) AND #&lt;this_attr&gt; = :prev
            </code>{" "}
            to every update. The user owns advancement of this value (it is never auto-incremented).
          </p>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            data-testid="opt-lock-cancel-btn"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontFamily: "inherit",
              background: "transparent",
              border: "1px solid var(--border-strong, #2e2f3a)",
              borderRadius: 5,
              color: "var(--text-muted, #888)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="opt-lock-save-btn"
            onClick={handleSave}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontFamily: "inherit",
              background: "var(--accent, #a855f7)",
              border: "none",
              borderRadius: 5,
              color: "#fff",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
