import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { openConnectionFormWindow } from "@/platform/shell/connectionFormWindow";
import { ATHENA_KIND } from "./types";

interface AthenaFormControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  close: () => void;
}

const AthenaFormContext = createContext<AthenaFormControllerValue | null>(null);

export function AthenaFormProvider({
  children,
}: {
  children: ReactNode;
}) {
  const openCreate = useCallback(
    () => void openConnectionFormWindow({ mode: "create", kind: ATHENA_KIND }),
    [],
  );

  const openEdit = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "edit", kind: ATHENA_KIND, connectionId: c.id }),
    [],
  );

  const openDuplicate = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "duplicate", kind: ATHENA_KIND, connectionId: c.id }),
    [],
  );

  // close is a no-op — the window manages its own close lifecycle
  const close = useCallback(() => {}, []);

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, close }),
    [openCreate, openEdit, openDuplicate, close],
  );

  return (
    <AthenaFormContext.Provider value={value}>
      {children}
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
