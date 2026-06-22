import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { openConnectionFormWindow } from "@/platform/shell/connectionFormWindow";
import { MYSQL_KIND } from "./types";

interface ControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  close: () => void;
}

const Ctx = createContext<ControllerValue | null>(null);

export function MysqlFormProvider({ children }: { children: ReactNode }) {
  const openCreate = useCallback(
    () => void openConnectionFormWindow({ mode: "create", kind: MYSQL_KIND }),
    [],
  );
  const openEdit = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "edit", kind: MYSQL_KIND, connectionId: c.id }),
    [],
  );
  const openDuplicate = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "duplicate", kind: MYSQL_KIND, connectionId: c.id }),
    [],
  );
  // close is a no-op — the window manages its own close lifecycle
  const close = useCallback(() => {}, []);

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, close }),
    [openCreate, openEdit, openDuplicate, close],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMysqlForm(): ControllerValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useMysqlForm must be used within MysqlFormProvider");
  }
  return v;
}
