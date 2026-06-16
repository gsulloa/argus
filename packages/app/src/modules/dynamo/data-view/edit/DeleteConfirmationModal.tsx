/**
 * DeleteConfirmationModal — task 9.3
 *
 * Three-phase modal for sequential multi-row delete:
 *   1. "confirm" — lists every row's key label; Cancel + "Delete N items" (destructive).
 *   2. "flight"  — dispatches dynamo.delete_item per row sequentially with per-row
 *                  status indicators. Escape disabled; click-outside disabled.
 *   3. "done"    — shows "X of Y deleted" summary; failures listed with AWS code+message.
 *                  Close button only.
 *
 * Spec: §9 Multi-row delete requirement + scenarios.
 * Design: design.md §6 — monospace font for keys, --danger for destructive action.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Loader2, Check, X } from "lucide-react";
import { dynamoDeleteItem } from "../api";
import { AppError } from "@/platform/errors/AppError";
import type { AttributeMap } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeleteRow {
  rowIndex: number;
  key: AttributeMap;
  /** Human-readable key label, e.g. `pk=user-1, sk=evt-1` */
  label: string;
}

export interface DeleteConfirmationModalProps {
  open: boolean;
  rows: DeleteRow[];
  connectionId: string;
  tableName: string;
  onClose: () => void;
  onComplete: (deletedIndices: number[]) => void;
}

type Phase = "confirm" | "flight" | "done";

interface RowStatus {
  ok: boolean;
  code?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DeleteConfirmationModal({
  open,
  rows,
  connectionId,
  tableName,
  onClose,
  onComplete,
}: DeleteConfirmationModalProps) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [statuses, setStatuses] = useState<Map<number, RowStatus>>(new Map());
  const [successIndices, setSuccessIndices] = useState<number[]>([]);

  // Reset state when modal is opened fresh
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setPhase("confirm");
      setCurrentIndex(-1);
      setStatuses(new Map());
      setSuccessIndices([]);
    }
    prevOpen.current = open;
  }, [open]);

  // Escape key handler — disabled during flight
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (phase === "flight") {
          // Disabled during sequential dispatch per spec §9
          e.preventDefault();
          return;
        }
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase, onClose]);

  // ---------------------------------------------------------------------------
  // Sequential dispatch
  // ---------------------------------------------------------------------------

  async function runDelete() {
    setPhase("flight");
    const successes: number[] = [];
    const nextStatuses = new Map<number, RowStatus>();

    for (let i = 0; i < rows.length; i++) {
      setCurrentIndex(i);
      try {
        await dynamoDeleteItem(connectionId, tableName, {
          key: rows[i]!.key,
          condition_expression: null,
          expression_attribute_names: null,
          expression_attribute_values: null,
          return_values: null,
        });
        nextStatuses.set(i, { ok: true });
        successes.push(rows[i]!.rowIndex);
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        const code = err.aws?.code;
        const message = err.aws?.message ?? err.message;
        nextStatuses.set(i, { ok: false, code, message });
      }
      // Trigger re-render after each row
      setStatuses(new Map(nextStatuses));
    }

    setSuccessIndices(successes);
    setPhase("done");
    onComplete(successes);
  }

  if (!open) return null;

  // ---------------------------------------------------------------------------
  // Backdrop click — no-op during flight
  // ---------------------------------------------------------------------------

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (phase === "flight") return;
    onClose();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const n = rows.length;

  return (
    <div style={backdropStyle} onClick={handleBackdropClick} data-testid="delete-modal-backdrop">
      <div style={dialogStyle} role="alertdialog" aria-modal="true">

        {/* Header */}
        <div style={headerStyle}>
          {phase === "confirm" && `Delete ${n} item${n !== 1 ? "s" : ""}?`}
          {phase === "flight" && `Deleting ${n} item${n !== 1 ? "s" : ""}…`}
          {phase === "done" && `${successIndices.length} of ${n} deleted`}
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {phase === "confirm" && (
            <>
              <p style={{ margin: "0 0 10px", color: "var(--text-muted)", fontSize: 12 }}>
                The following items will be permanently deleted:
              </p>
              <ul style={keyListStyle}>
                {rows.map((row, i) => (
                  <li key={i} style={keyItemStyle} data-testid="delete-row-label">
                    <span style={monoStyle}>{row.label}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {(phase === "flight" || phase === "done") && (
            <ul style={{ ...keyListStyle, listStyle: "none", padding: 0 }}>
              {rows.map((row, i) => {
                const status = statuses.get(i);
                const isCurrent = phase === "flight" && i === currentIndex;
                const isPending = phase === "flight" && i > currentIndex;
                return (
                  <li key={i} style={progressItemStyle} data-testid={`delete-progress-row-${i}`}>
                    {/* Status icon */}
                    <span style={statusIconStyle}>
                      {isCurrent && (
                        <Loader2
                          size={13}
                          style={{ animation: "spin 1s linear infinite" }}
                          data-testid="row-spinner"
                        />
                      )}
                      {status?.ok === true && (
                        <Check size={13} style={{ color: "var(--success, #4ade80)" }} data-testid="row-check" />
                      )}
                      {status?.ok === false && (
                        <X size={13} style={{ color: "var(--danger)" }} data-testid="row-error-icon" />
                      )}
                      {isPending && (
                        <span style={{ width: 13, height: 13, display: "inline-block" }} />
                      )}
                    </span>
                    {/* Key label + optional error */}
                    <span>
                      <span style={monoStyle} data-testid="delete-row-label">{row.label}</span>
                      {status?.ok === false && (
                        <div style={errorMsgStyle} data-testid="row-error-msg">
                          {status.code && <strong>{status.code}: </strong>}
                          {status.message}
                        </div>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {phase === "done" && successIndices.length < n && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              {n - successIndices.length} item{n - successIndices.length !== 1 ? "s" : ""} failed and remain in the list.
            </p>
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          {phase === "confirm" && (
            <>
              <button
                type="button"
                style={btnStyle}
                onClick={onClose}
                data-testid="delete-cancel-btn"
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...btnStyle, ...btnDangerStyle }}
                onClick={() => { void runDelete(); }}
                data-testid="delete-confirm-btn"
              >
                Delete {n} item{n !== 1 ? "s" : ""}
              </button>
            </>
          )}

          {phase === "flight" && (
            <button type="button" style={{ ...btnStyle, opacity: 0.5, cursor: "not-allowed" }} disabled>
              Deleting…
            </button>
          )}

          {phase === "done" && (
            <button
              type="button"
              style={btnStyle}
              onClick={onClose}
              data-testid="delete-close-btn"
              autoFocus
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--bg-overlay, rgba(0,0,0,0.5))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const dialogStyle: CSSProperties = {
  width: 440,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "80vh",
  background: "var(--bg-elevated, var(--surface))",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  boxShadow: "var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.4))",
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
  overflowY: "auto",
  flex: 1,
};

const keyListStyle: CSSProperties = {
  margin: 0,
  padding: "0 0 0 0",
  listStyle: "none",
};

const keyItemStyle: CSSProperties = {
  padding: "3px 0",
};

const progressItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "4px 0",
};

const statusIconStyle: CSSProperties = {
  marginTop: 1,
  flexShrink: 0,
  display: "inline-flex",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--text)",
};

const errorMsgStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--danger)",
  marginTop: 2,
  fontFamily: "var(--font-mono)",
  wordBreak: "break-word",
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
  fontFamily: "inherit",
};

const btnDangerStyle: CSSProperties = {
  background: "var(--danger)",
  color: "white",
  borderColor: "var(--danger)",
};
