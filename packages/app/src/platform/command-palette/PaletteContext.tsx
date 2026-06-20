import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

export type TableScope = "focused" | "all-open";

type ActivePalette = "command" | "table" | null;

interface CoordinatorState {
  active: ActivePalette;
  setActive: Dispatch<SetStateAction<ActivePalette>>;
  tableScope: TableScope;
  setTableScope: Dispatch<SetStateAction<TableScope>>;
}

interface PaletteCtx {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

export interface TablePaletteCtx extends PaletteCtx {
  /** Current scope: "focused" (default, ⌘P) or "all-open" (⌥⌘P). */
  tableScope: TableScope;
  /** Open the table palette with a specific scope. */
  show: (scope?: TableScope) => void;
}

const Coordinator = createContext<CoordinatorState | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActivePalette>(null);
  const [tableScope, setTableScope] = useState<TableScope>("focused");
  const value = useMemo<CoordinatorState>(
    () => ({ active, setActive, tableScope, setTableScope }),
    [active, tableScope],
  );
  return <Coordinator.Provider value={value}>{children}</Coordinator.Provider>;
}

function useCoordinator(hookName: string): CoordinatorState {
  const v = useContext(Coordinator);
  if (!v) throw new Error(`${hookName} must be used inside PaletteProvider`);
  return v;
}

export function usePalette(): PaletteCtx {
  const { active, setActive } = useCoordinator("usePalette");
  // Mutual exclusion is implicit: show() overwrites the shared `active`,
  // so opening the command palette closes the table switcher and vice versa.
  const show = useCallback(() => setActive("command"), [setActive]);
  const hide = useCallback(
    () => setActive((a) => (a === "command" ? null : a)),
    [setActive],
  );
  const toggle = useCallback(
    () => setActive((a) => (a === "command" ? null : "command")),
    [setActive],
  );
  return useMemo(
    () => ({ open: active === "command", show, hide, toggle }),
    [active, show, hide, toggle],
  );
}

export function useTablePalette(): TablePaletteCtx {
  const { active, setActive, tableScope, setTableScope } = useCoordinator("useTablePalette");
  const show = useCallback(
    (scope: TableScope = "focused") => {
      setTableScope(scope);
      setActive("table");
    },
    [setActive, setTableScope],
  );
  const hide = useCallback(
    () => setActive((a) => (a === "table" ? null : a)),
    [setActive],
  );
  const toggle = useCallback(
    () => setActive((a) => (a === "table" ? null : "table")),
    [setActive],
  );
  return useMemo(
    () => ({ open: active === "table", tableScope, show, hide, toggle }),
    [active, tableScope, show, hide, toggle],
  );
}
