import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { contextApi } from "@/modules/context/api";
import type { SyncReport } from "@/modules/context/types";
import styles from "./SyncReportModal.module.css";

export interface SyncReportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  /** Called when a sync completes successfully, so the parent can react. */
  onSynced?: () => void;
}

type State =
  | { kind: "syncing" }
  | { kind: "done"; report: SyncReport }
  | { kind: "error"; message: string };

export function SyncReportModal({ open, onOpenChange, connectionId, onSynced }: SyncReportModalProps) {
  const [state, setState] = useState<State>({ kind: "syncing" });
  // Track whether we already ran the sync for this open session to avoid re-running.
  const runKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Use a key based on open + connectionId so re-opening after changing connection re-runs.
    const key = `${connectionId}::${Date.now()}`;
    if (runKeyRef.current === key) return;
    runKeyRef.current = key;

    setState({ kind: "syncing" });
    contextApi
      .syncSchema(connectionId)
      .then((report) => {
        setState({ kind: "done", report });
        onSynced?.();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message: msg });
      });
  // Re-run whenever open transitions to true.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId]);

  // Reset runKeyRef when closed so next open re-runs.
  useEffect(() => {
    if (!open) runKeyRef.current = null;
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>Schema Sync</Dialog.Title>

          {state.kind === "syncing" && (
            <div className={styles.syncingRow}>
              <span className={styles.syncingText}>Syncing schema</span>
              <span className={styles.dots} aria-label="loading">...</span>
            </div>
          )}

          {state.kind === "error" && (
            <div className={styles.errorSection}>
              <p className={styles.errorText}>{state.message}</p>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  runKeyRef.current = null;
                  setState({ kind: "syncing" });
                  contextApi
                    .syncSchema(connectionId)
                    .then((report) => {
                      setState({ kind: "done", report });
                      onSynced?.();
                    })
                    .catch((err: unknown) => {
                      const msg = err instanceof Error ? err.message : String(err);
                      setState({ kind: "error", message: msg });
                    });
                }}
              >
                Retry
              </button>
            </div>
          )}

          {state.kind === "done" && (
            <div className={styles.report}>
              {state.report.created.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Created ({state.report.created.length})
                  </h3>
                  <PathList paths={state.report.created} />
                </section>
              )}
              {state.report.updated.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Updated ({state.report.updated.length})
                  </h3>
                  <PathList paths={state.report.updated} />
                </section>
              )}
              {state.report.marked_deleted.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Marked deleted ({state.report.marked_deleted.length})
                  </h3>
                  <PathList
                    paths={state.report.marked_deleted}
                    chip="no DB match"
                    chipClass={styles.chipWarning}
                  />
                </section>
              )}
              {state.report.orphaned_notes.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Orphaned notes ({state.report.orphaned_notes.length})
                  </h3>
                  <p className={styles.orphanHint}>
                    Column was renamed or removed. Edit the file to rename the note key or delete it.
                  </p>
                  <ul className={styles.pathList}>
                    {state.report.orphaned_notes.map((n, i) => (
                      <li key={i} className={styles.pathItem}>
                        <span className={styles.mono}>{n.file} · {n.key}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {state.report.created.length === 0 &&
                state.report.updated.length === 0 &&
                state.report.marked_deleted.length === 0 &&
                state.report.orphaned_notes.length === 0 && (
                  <p className={styles.noChanges}>No changes — schema is already up to date.</p>
                )}
            </div>
          )}

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.btn}
              onClick={() => onOpenChange(false)}
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Path list helper
// ---------------------------------------------------------------------------

interface PathListProps {
  paths: string[];
  chip?: string;
  chipClass?: string;
}

function PathList({ paths, chip, chipClass }: PathListProps) {
  return (
    <ul className={styles.pathList}>
      {paths.map((p, i) => (
        <li key={i} className={styles.pathItem}>
          <span className={styles.mono}>{p}</span>
          {chip && <span className={`${styles.chip} ${chipClass ?? ""}`}>{chip}</span>}
        </li>
      ))}
    </ul>
  );
}
