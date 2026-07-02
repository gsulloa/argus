/**
 * NamePromptDialog — a simple modal that prompts for a text name.
 * Used by ContextQueriesBranch for "New context query" creation.
 */
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./SavedQueriesPanel.module.css";
import { noAutoCorrectProps } from "../shared/text-input-hygiene";

export interface NamePromptDialogProps {
  open: boolean;
  title: string;
  placeholder?: string;
  /** Pre-fill the input with this value (e.g. for rename flows). */
  initialValue?: string;
  /** Label for the confirm button (defaults to "Create"). */
  confirmLabel?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function NamePromptDialog({
  open,
  title,
  placeholder = "Query name",
  initialValue,
  confirmLabel = "Create",
  onConfirm,
  onCancel,
}: NamePromptDialogProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue ?? "");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initialValue]);

  function commit() {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>{title}</Dialog.Title>
          <input
            {...noAutoCorrectProps}
            ref={inputRef}
            type="text"
            className={styles.renameInput}
            style={{ width: "100%", marginTop: 8, marginBottom: 8 }}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            }}
          />
          <div className={dialogStyles.footer}>
            <button type="button" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className={dialogStyles.primary}
              disabled={!value.trim()}
              onClick={commit}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
