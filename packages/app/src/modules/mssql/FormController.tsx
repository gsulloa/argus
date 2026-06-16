import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { MssqlConnectionForm } from "./ConnectionForm";

type Mode = "create" | "edit" | "duplicate";

interface FormState {
  open: boolean;
  mode: Mode;
  initial?: Connection;
}

interface ControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  close: () => void;
}

const Ctx = createContext<ControllerValue | null>(null);

export function MssqlFormProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FormState>({ open: false, mode: "create" });

  const openCreate = useCallback(() => setState({ open: true, mode: "create" }), []);
  const openEdit = useCallback(
    (c: Connection) => setState({ open: true, mode: "edit", initial: c }),
    [],
  );
  const openDuplicate = useCallback(
    (c: Connection) => setState({ open: true, mode: "duplicate", initial: c }),
    [],
  );
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, close }),
    [openCreate, openEdit, openDuplicate, close],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <MssqlConnectionForm
        open={state.open}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
        mode={state.mode}
        initial={state.initial}
      />
    </Ctx.Provider>
  );
}

export function useMssqlForm(): ControllerValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useMssqlForm must be used within MssqlFormProvider");
  }
  return v;
}
