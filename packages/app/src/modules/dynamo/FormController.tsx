import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { DynamoConnectionForm, type FormMode } from "./ConnectionForm";

interface DynamoFormControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  openCredentialsOnly: (c: Connection) => void;
  close: () => void;
}

interface ControllerState {
  open: boolean;
  mode: FormMode;
}

interface DynamoFormProviderProps {
  children: ReactNode;
  /** Notified once a connection is saved (created or updated). */
  onSaved?: (saved: Connection) => void;
  /** Notified after a successful Save & Connect — passes the newly active id. */
  onConnected?: (id: string) => void;
}

const DynamoFormContext = createContext<DynamoFormControllerValue | null>(null);

export function DynamoFormProvider({
  children,
  onSaved,
  onConnected,
}: DynamoFormProviderProps) {
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

  const openCredentialsOnly = useCallback(
    (c: Connection) =>
      setState({ open: true, mode: { kind: "credentials-only", connection: c } }),
    [],
  );

  const close = useCallback(
    () => setState((s) => ({ ...s, open: false })),
    [],
  );

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, openCredentialsOnly, close }),
    [openCreate, openEdit, openDuplicate, openCredentialsOnly, close],
  );

  return (
    <DynamoFormContext.Provider value={value}>
      {children}
      <DynamoConnectionForm
        open={state.open}
        mode={state.mode}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
        onSaved={onSaved}
        onConnected={onConnected}
      />
    </DynamoFormContext.Provider>
  );
}

export function useDynamoForm(): DynamoFormControllerValue {
  const ctx = useContext(DynamoFormContext);
  if (!ctx) {
    throw new Error("useDynamoForm must be used inside DynamoFormProvider");
  }
  return ctx;
}
