import * as Dialog from "@radix-ui/react-dialog";
import { Command as Cmdk } from "cmdk";
import type { ReactNode } from "react";
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
            <Cmdk.Input
              autoFocus
              className={styles.input}
              placeholder={placeholder}
              value={search}
              onValueChange={onSearchChange}
            />
            <Cmdk.List className={styles.list}>{children}</Cmdk.List>
          </Cmdk>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
