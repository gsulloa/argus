import * as Dialog from "@radix-ui/react-dialog";
import { Command as Cmdk } from "cmdk";
import type { ReactNode, Ref } from "react";
import styles from "./Palette.module.css";

export type PaletteFilter = (
  value: string,
  search: string,
  keywords?: string[],
) => number;

export interface PaletteShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visually hidden a11y title. */
  title: string;
  /** ARIA label for the cmdk root. */
  ariaLabel: string;
  placeholder: string;
  search: string;
  onSearchChange: (value: string) => void;
  /** Pass false when the list is empty or the consumer renders only static
   *  content; cmdk would otherwise filter away custom empty/loading nodes. */
  shouldFilter?: boolean;
  /** Optional custom filter forwarded to cmdk. When omitted, cmdk uses its
   *  default `command-score` fuzzy scorer (current behaviour for ⌘K). */
  filter?: PaletteFilter;
  children: ReactNode;
  listRef?: Ref<HTMLDivElement>;
  /**
   * Optional scope indicator rendered inline with the search input.
   * Used by the table palette to surface "This connection" vs "All open
   * connections" (Decision 6 / Phase 7).
   */
  scopeLabel?: string;
}

/**
 * Shared scaffold for ⌘K (commands) and ⌘P (tables). Owns the Radix Dialog,
 * cmdk root, search input, and list container. Consumers render groups/items
 * (or empty/loading nodes) as `children`.
 */
export function PaletteShell({
  open,
  onOpenChange,
  title,
  ariaLabel,
  placeholder,
  search,
  onSearchChange,
  shouldFilter = true,
  filter,
  children,
  listRef,
  scopeLabel,
}: PaletteShellProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          <Cmdk
            label={ariaLabel}
            shouldFilter={shouldFilter}
            value={undefined}
            {...(filter ? { filter } : {})}
          >
            <div className={styles.inputRow}>
              <Cmdk.Input
                autoFocus
                className={styles.input}
                placeholder={placeholder}
                value={search}
                onValueChange={onSearchChange}
              />
              {scopeLabel && (
                <span className={styles.scopeChip}>{scopeLabel}</span>
              )}
            </div>
            <Cmdk.List ref={listRef} className={styles.list}>{children}</Cmdk.List>
          </Cmdk>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
