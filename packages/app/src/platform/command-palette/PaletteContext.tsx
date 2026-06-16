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

type ActivePalette = "command" | "table" | null;

interface CoordinatorState {
  active: ActivePalette;
  setActive: Dispatch<SetStateAction<ActivePalette>>;
}

interface PaletteCtx {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

const Coordinator = createContext<CoordinatorState | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActivePalette>(null);
  const value = useMemo<CoordinatorState>(() => ({ active, setActive }), [active]);
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

export function useTablePalette(): PaletteCtx {
  const { active, setActive } = useCoordinator("useTablePalette");
  const show = useCallback(() => setActive("table"), [setActive]);
  const hide = useCallback(
    () => setActive((a) => (a === "table" ? null : a)),
    [setActive],
  );
  const toggle = useCallback(
    () => setActive((a) => (a === "table" ? null : "table")),
    [setActive],
  );
  return useMemo(
    () => ({ open: active === "table", show, hide, toggle }),
    [active, show, hide, toggle],
  );
}
