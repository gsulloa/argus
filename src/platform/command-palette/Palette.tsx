import * as Dialog from "@radix-ui/react-dialog";
import { Command as Cmdk } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import { CommandRegistry, type Command } from "./CommandRegistry";
import { usePalette } from "./PaletteContext";
import styles from "./Palette.module.css";

function formatHotkey(h: Command["hotkey"]): string | null {
  if (!h) return null;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts: string[] = [];
  if (h.mod ?? true) parts.push(isMac ? "⌘" : "Ctrl");
  if (h.shift) parts.push(isMac ? "⇧" : "Shift");
  if (h.alt) parts.push(isMac ? "⌥" : "Alt");
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return parts.join(isMac ? "" : "+");
}

function useCommands(): Command[] {
  const [, setVersion] = useState(0);
  useEffect(() => CommandRegistry.subscribe(() => setVersion((v) => v + 1)), []);
  return CommandRegistry.list();
}

export function Palette() {
  const { open, hide } = usePalette();
  const commands = useCommands();
  const [search, setSearch] = useState("");

  // Reset search whenever the palette opens.
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const c of commands) {
      const key = c.group ?? "Commands";
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.label.localeCompare(b.label));
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [commands]);

  const isEmpty = commands.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && hide()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} onOpenAutoFocus={(e) => e.preventDefault()}>
          <Dialog.Title className={styles.title}>Command palette</Dialog.Title>
          <Cmdk label="Command palette" shouldFilter={!isEmpty} value={undefined}>
            <Cmdk.Input
              autoFocus
              className={styles.input}
              placeholder={isEmpty ? "No commands available yet" : "Type a command…"}
              value={search}
              onValueChange={setSearch}
            />
            <Cmdk.List className={styles.list}>
              {isEmpty ? (
                <div className={styles.empty}>
                  No commands available yet. Modules will register commands here.
                </div>
              ) : (
                <>
                  <Cmdk.Empty>
                    <div className={styles.empty}>No matching commands</div>
                  </Cmdk.Empty>
                  {grouped.map(([group, items]) => (
                    <Cmdk.Group key={group} heading={group} className={styles.group}>
                      {items.map((cmd) => (
                        <Cmdk.Item
                          key={cmd.id}
                          value={`${cmd.label} ${cmd.keywords?.join(" ") ?? ""}`}
                          className={styles.item}
                          onSelect={async () => {
                            if (!cmd.keepOpen) hide();
                            await cmd.run();
                          }}
                        >
                          <span className={styles.label}>{cmd.label}</span>
                          {cmd.hotkey && (
                            <span className={styles.hotkey}>{formatHotkey(cmd.hotkey)}</span>
                          )}
                        </Cmdk.Item>
                      ))}
                    </Cmdk.Group>
                  ))}
                </>
              )}
            </Cmdk.List>
          </Cmdk>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
