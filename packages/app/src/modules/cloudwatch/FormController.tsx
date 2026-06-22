import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { openConnectionFormWindow } from "@/platform/shell/connectionFormWindow";
import { CLOUDWATCH_KIND } from "./types";

interface CloudwatchFormControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  close: () => void;
}

const CloudwatchFormContext = createContext<CloudwatchFormControllerValue | null>(null);

export function CloudwatchFormProvider({
  children,
}: {
  children: ReactNode;
}) {
  const openCreate = useCallback(
    () => void openConnectionFormWindow({ mode: "create", kind: CLOUDWATCH_KIND }),
    [],
  );

  const openEdit = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "edit", kind: CLOUDWATCH_KIND, connectionId: c.id }),
    [],
  );

  const openDuplicate = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "duplicate", kind: CLOUDWATCH_KIND, connectionId: c.id }),
    [],
  );

  // close is a no-op — the window manages its own close lifecycle
  const close = useCallback(() => {}, []);

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, close }),
    [openCreate, openEdit, openDuplicate, close],
  );

  return (
    <CloudwatchFormContext.Provider value={value}>
      {children}
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
