/**
 * ConnectionSelector — toolbar dropdown that lists all registered connections
 * with their live status dot, ordered by group (same data source as the
 * Connections sidebar). Reactive to connection add/remove/rename/status.
 */

import { useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useConnectionGroups } from "@/platform/connection-registry/useConnectionGroups";
import { useActiveConnections } from "../useActiveConnections";
import type { Connection } from "@/platform/connection-registry/types";
import styles from "./ConnectionSelector.module.css";

export interface ConnectionSelectorProps {
  currentConnectionId: string | null;
  onSelect: (id: string, name: string) => void;
}

interface GroupedSection {
  label: string;
  items: Connection[];
}

export function ConnectionSelector({
  currentConnectionId,
  onSelect,
}: ConnectionSelectorProps) {
  const connections = useConnections();
  const groups = useConnectionGroups();
  const { isActive } = useActiveConnections();
  const [open, setOpen] = useState(false);

  // Build ordered list: groups (in sort_order order) then ungrouped.
  const sections = useMemo((): GroupedSection[] => {
    const byGroup = new Map<string, Connection[]>();
    const ungrouped: Connection[] = [];
    for (const c of connections.items) {
      if (c.group_id) {
        const arr = byGroup.get(c.group_id) ?? [];
        arr.push(c);
        byGroup.set(c.group_id, arr);
      } else {
        ungrouped.push(c);
      }
    }

    const result: GroupedSection[] = [];
    for (const g of groups.items) {
      const members = byGroup.get(g.id) ?? [];
      if (members.length > 0) {
        result.push({ label: g.name, items: members });
      }
    }
    if (ungrouped.length > 0) {
      result.push({ label: "Ungrouped", items: ungrouped });
    }
    return result;
  }, [connections.items, groups.items]);

  const currentConnection = connections.items.find((c) => c.id === currentConnectionId);
  const currentActive = currentConnectionId ? isActive(currentConnectionId) : false;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          aria-label="Select connection"
          title="Select connection"
        >
          {currentConnection ? (
            <>
              <span
                className={styles.dot}
                data-active={currentActive}
                aria-hidden="true"
              />
              <span className={styles.triggerName}>{currentConnection.name}</span>
            </>
          ) : (
            <span className={styles.placeholder}>Select connection…</span>
          )}
          <ChevronDown size={10} className={styles.chevron} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles.content}
          align="start"
          sideOffset={4}
        >
          {connections.items.length === 0 && (
            <div className={styles.empty}>No connections configured.</div>
          )}
          {sections.map((section, sIdx) => (
            <div key={section.label}>
              {sections.length > 1 && (
                <div className={styles.groupLabel}>{section.label}</div>
              )}
              {section.items.map((conn) => {
                const active = isActive(conn.id);
                const isSelected = conn.id === currentConnectionId;
                return (
                  <DropdownMenu.Item
                    key={conn.id}
                    className={styles.item}
                    data-selected={isSelected || undefined}
                    onSelect={() => onSelect(conn.id, conn.name)}
                  >
                    <span
                      className={styles.dot}
                      data-active={active}
                      aria-label={active ? "connected" : "disconnected"}
                    />
                    <span className={styles.itemName}>{conn.name}</span>
                  </DropdownMenu.Item>
                );
              })}
              {sIdx < sections.length - 1 && (
                <DropdownMenu.Separator className={styles.separator} />
              )}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
