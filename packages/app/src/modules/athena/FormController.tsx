import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { AthenaConnectionForm, type FormMode } from "./ConnectionForm";

interface AthenaFormControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  close: () => void;
}

interface ControllerState {
  open: boolean;
  mode: FormMode;
}

interface AthenaFormProviderProps {
  children: ReactNode;
  onSaved?: (saved: Connection) => void;
  onConnected?: (id: string) => void;
}

const AthenaFormContext = createContext<AthenaFormControllerValue | null>(null);

export function AthenaFormProvider({
  children,
  onSaved,
  onConnected,
}: AthenaFormProviderProps) {
  const [state, setState] = useState<ControllerState>({
    open: false,
    mode: { kind: "create" },
  });

  const openCreate = useCallback(
    () => setState({ open: true, mode: { kind: "create" } }),
    [],
  );

  const openEdit = useCallback(
    (c: Connection) =>
      setState({ open: true, mode: { kind: "edit", connection: c } }),
    [],
  );

  const openDuplicate = useCallback(
    (c: Connection) =>
      setState({ open: true, mode: { kind: "duplicate", connection: c } }),
    [],
  );

  const close = useCallback(
    () => setState((s) => ({ ...s, open: false })),
    [],
  );

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, close }),
    [openCreate, openEdit, openDuplicate, close],
  );

  return (
    <AthenaFormContext.Provider value={value}>
      {children}
      <AthenaConnectionForm
        open={state.open}
        mode={state.mode}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
        onSaved={onSaved}
        onConnected={onConnected}
      />
    </AthenaFormContext.Provider>
  );
}

export function useAthenaForm(): AthenaFormControllerValue {
  const ctx = useContext(AthenaFormContext);
  if (!ctx) {
    throw new Error("useAthenaForm must be used inside AthenaFormProvider");
  }
  return ctx;
}
