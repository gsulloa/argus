import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Filter } from "lucide-react";
import type { SchemaSummary } from "./types";
import type { UseVisibleSchemasResult } from "./useVisibleSchemas";
import styles from "./VisibleSchemasPicker.module.css";

interface Props {
  schemas: SchemaSummary[];
  visibility: UseVisibleSchemasResult;
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}

export function VisibleSchemasPicker({ schemas, visibility, open, onOpenChange }: Props) {
  const isFiltered = !visibility.isDefault || visibility.showSystem;
  const visibleSchemas = schemas.filter((s) => visibility.showSystem || !s.is_system);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Filter visible schemas"
          title="Filter visible schemas"
          className={
            isFiltered
              ? `${styles.triggerButton} ${styles.triggerActive}`
              : styles.triggerButton
          }
        >
          <Filter size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles.content}
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className={styles.header}>Visible schemas</div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={(e) => {
                e.preventDefault();
                visibility.selectAll();
              }}
            >
              Select all
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={(e) => {
                e.preventDefault();
                visibility.clear();
              }}
            >
              Clear
            </button>
          </div>

          <div className={styles.list}>
            {visibleSchemas.length === 0 && (
              <div className={styles.header} style={{ textTransform: "none" }}>
                No schemas
              </div>
            )}
            {visibleSchemas.map((s) => {
              const checked = visibility.visible.has(s.name);
              return (
                <DropdownMenu.CheckboxItem
                  key={s.name}
                  className={styles.item}
                  checked={checked}
                  onCheckedChange={() => visibility.toggleSchema(s.name)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className={styles.checkbox}>
                    {checked && <Check size={12} />}
                  </span>
                  <span>{s.name}</span>
                  {s.is_system && <span className={styles.systemTag}>SYS</span>}
                </DropdownMenu.CheckboxItem>
              );
            })}
          </div>

          <div className={styles.divider} />
          <DropdownMenu.CheckboxItem
            className={styles.systemToggle}
            checked={visibility.showSystem}
            onCheckedChange={() => visibility.toggleShowSystem()}
            onSelect={(e) => e.preventDefault()}
          >
            <span className={styles.checkbox}>
              {visibility.showSystem && <Check size={12} />}
            </span>
            Show system schemas
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
