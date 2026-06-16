export interface HotkeyDescriptor {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Command {
  id: string;
  label: string;
  group?: string;
  keywords?: string[];
  hotkey?: HotkeyDescriptor;
  /** When true, the palette stays open after the command runs. */
  keepOpen?: boolean;
  run: () => void | Promise<void>;
}

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export const CommandRegistry = {
  register(cmd: Command): () => void {
    commands.set(cmd.id, cmd);
    notify();
    return () => {
      const cur = commands.get(cmd.id);
      if (cur === cmd) {
        commands.delete(cmd.id);
        notify();
      }
    };
  },
  unregister(id: string) {
    if (commands.delete(id)) notify();
  },
  list(): Command[] {
    return Array.from(commands.values());
  },
  get(id: string): Command | undefined {
    return commands.get(id);
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
