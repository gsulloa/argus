import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { CloudwatchConnectionForm, type FormMode } from "./ConnectionForm";

interface CloudwatchFormControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  close: () => void;
}

interface ControllerState {
  open: boolean;
  mode: FormMode;
}

interface CloudwatchFormProviderProps {
  children: ReactNode;
  onSaved?: (saved: Connection) => void;
  onConnected?: (id: string) => void;
}

const CloudwatchFormContext = createContext<CloudwatchFormControllerValue | null>(null);

export function CloudwatchFormProvider({
  children,
  onSaved,
  onConnected,
}: CloudwatchFormProviderProps) {
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
    <CloudwatchFormContext.Provider value={value}>
      {children}
      <CloudwatchConnectionForm
        open={state.open}
        mode={state.mode}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
        onSaved={onSaved}
        onConnected={onConnected}
      />
    </CloudwatchFormContext.Provider>
  );
}

export function useCloudwatchForm(): CloudwatchFormControllerValue {
  const ctx = useContext(CloudwatchFormContext);
  if (!ctx) {
    throw new Error("useCloudwatchForm must be used inside CloudwatchFormProvider");
  }
  return ctx;
}
