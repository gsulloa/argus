import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logUpdater } from "@/platform/updater";
import { writeClipboardText, COPY_FAILED_MESSAGE } from "@/platform/clipboard";
import { useToast } from "@/platform/toast";
import overlayStyles from "./Dialog.module.css";
import styles from "./VersionIndicator.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

function isRevealLabel(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")) {
    return "Reveal in Finder";
  }
  return "Open log folder";
}

export function UpdaterLogsDialog({ open, onClose }: Props) {
  const [logs, setLogs] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState<"Copy" | "Copied">("Copy");
  const toast = useToast();

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await invoke<string>("updater_logs_tail", { maxLines: 200 });
      setLogs(result);
    } catch (err) {
      setLogs(`(error reading logs: ${String(err)})`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch logs and log the open event when the dialog first opens.
  useEffect(() => {
    if (!open) return;
    logUpdater("info", "user_opened_logs_viewer");
    void fetchLogs();
  }, [open, fetchLogs]);

  const handleReveal = useCallback(async () => {
    setRevealError(null);
    try {
      await invoke<void>("updater_logs_reveal");
    } catch (err) {
      // The error message from Rust starts with "Log folder: /abs/path"
      setRevealError(String(err));
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await writeClipboardText(logs);
    if (ok) {
      setCopyLabel("Copied");
      window.setTimeout(() => setCopyLabel("Copy"), 1_500);
    } else {
      toast.show(COPY_FAILED_MESSAGE, "error");
    }
  }, [logs, toast]);

  const revealLabel = isRevealLabel();

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayStyles.overlay} />
        <Dialog.Content
          className={overlayStyles.content}
          style={{ minWidth: 480, maxWidth: 640 }}
        >
          <Dialog.Title className={overlayStyles.title}>Update logs</Dialog.Title>
          <Dialog.Description className={overlayStyles.description}>
            Last 200 updater-tagged log lines from the current session.
          </Dialog.Description>

          <pre className={styles.logsPane}>
            {isLoading ? "(loading…)" : logs}
          </pre>

          {revealError && (
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              {revealError}
            </p>
          )}

          <div className={overlayStyles.footer} style={{ marginTop: 12, justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className={styles.logsButton}
                onClick={() => void fetchLogs()}
                disabled={isLoading}
              >
                Refresh
              </button>
              <button
                className={styles.logsButton}
                onClick={() => void handleReveal()}
              >
                {revealLabel}
              </button>
              <button
                className={styles.logsButton}
                onClick={() => void handleCopy()}
              >
                {copyLabel}
              </button>
            </div>
            <button className={overlayStyles.primary} onClick={onClose}>
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
