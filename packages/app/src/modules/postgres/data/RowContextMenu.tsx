import * as ContextMenu from "@radix-ui/react-context-menu";
import styles from "./RowContextMenu.module.css";

export interface RowContextMenuProps {
  /** The children element that acts as the right-click trigger. */
  children: React.ReactNode;
  /** The cell that was right-clicked. */
  target: { rowIndex: number; colIndex: number };
  /** True when the action target spans multiple rows. Controls "(s)" pluralisation. */
  isMulti: boolean;
  /** Whether "Edit cell" can be invoked on the target cell. */
  canEditCell: boolean;
  /** Reason Edit cell is disabled (shown as tooltip / title). Empty string when enabled. */
  editCellDisabledReason: string;
  /** Whether "Delete / Restore row(s)" can be invoked. */
  canDeleteRows: boolean;
  /** Reason Delete is disabled. Empty string when enabled. */
  deleteDisabledReason: string;
  /** When true, the delete item reads "Restore row(s)" instead of "Delete row(s)". */
  deleteIsRestore: boolean;
  /** Copy the target cell value to clipboard. */
  onCopyCell(): void;
  /** Copy the target row(s) to clipboard as TSV. */
  onCopyRows(): void;
  /** Enter edit mode on the target cell. */
  onEditCell(): void;
  /** Toggle delete/restore on the target row(s). */
  onToggleDelete(): void;
}

/**
 * Right-click context menu for an editable data-grid row.
 *
 * Uses Radix `@radix-ui/react-context-menu` for automatic positioning,
 * focus trapping, Escape/outside-click dismissal, and disabled-item semantics.
 * Styled to match the project design system (thin border, 6 px radius, no gradients).
 */
export function RowContextMenu({
  children,
  isMulti,
  canEditCell,
  editCellDisabledReason,
  canDeleteRows,
  deleteDisabledReason,
  deleteIsRestore,
  onCopyCell,
  onCopyRows,
  onEditCell,
  onToggleDelete,
}: RowContextMenuProps) {
  const s = isMulti ? "s" : "";
  const deleteLabel = deleteIsRestore ? `Restore row${s}` : `Delete row${s}`;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.menu}>
          {/* Copy cell — always enabled */}
          <ContextMenu.Item
            className={styles.item}
            onSelect={onCopyCell}
          >
            Copy cell
          </ContextMenu.Item>

          {/* Copy row(s) — always enabled */}
          <ContextMenu.Item
            className={styles.item}
            onSelect={onCopyRows}
          >
            {`Copy row${s}`}
          </ContextMenu.Item>

          <ContextMenu.Separator className={styles.separator} />

          {/* Edit cell — disabled when read-only or no-PK or non-editable cell */}
          <ContextMenu.Item
            className={styles.item}
            disabled={!canEditCell}
            onSelect={onEditCell}
          >
            <span title={!canEditCell ? editCellDisabledReason : undefined}>
              Edit cell
            </span>
          </ContextMenu.Item>

          {/* Delete / Restore row(s) — disabled when read-only or no-PK */}
          <ContextMenu.Item
            className={`${styles.item} ${canDeleteRows ? styles.itemDanger : ""}`}
            disabled={!canDeleteRows}
            onSelect={onToggleDelete}
          >
            <span title={!canDeleteRows ? deleteDisabledReason : undefined}>
              {deleteLabel}
            </span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
