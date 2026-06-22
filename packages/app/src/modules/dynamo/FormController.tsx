import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { Connection } from "@/platform/connection-registry/types";
import { openConnectionFormWindow } from "@/platform/shell/connectionFormWindow";
import { DYNAMO_KIND } from "./types";

interface DynamoFormControllerValue {
  openCreate: () => void;
  openEdit: (c: Connection) => void;
  openDuplicate: (c: Connection) => void;
  /** Opens the form in credentials-only mode (re-enter expired creds). */
  openCredentialsOnly: (c: Connection) => void;
  close: () => void;
}

const DynamoFormContext = createContext<DynamoFormControllerValue | null>(null);

export function DynamoFormProvider({
  children,
}: {
  children: ReactNode;
}) {
  const openCreate = useCallback(
    () => void openConnectionFormWindow({ mode: "create", kind: DYNAMO_KIND }),
    [],
  );

  const openEdit = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "edit", kind: DYNAMO_KIND, connectionId: c.id }),
    [],
  );

  const openDuplicate = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({ mode: "duplicate", kind: DYNAMO_KIND, connectionId: c.id }),
    [],
  );

  // credentials-only is a dynamo-specific re-auth sub-mode. We carry it on the
  // intent's `subMode` field; ConnectionFormWindow maps it to the
  // `credentials-only` DynamoConnectionForm FormMode variant.
  const openCredentialsOnly = useCallback(
    (c: Connection) =>
      void openConnectionFormWindow({
        mode: "edit",
        kind: DYNAMO_KIND,
        connectionId: c.id,
        subMode: "credentials-only",
      }),
    [],
  );

  // close is a no-op — the window manages its own close lifecycle
  const close = useCallback(() => {}, []);

  const value = useMemo(
    () => ({ openCreate, openEdit, openDuplicate, openCredentialsOnly, close }),
    [openCreate, openEdit, openDuplicate, openCredentialsOnly, close],
  );

  return (
    <DynamoFormContext.Provider value={value}>
      {children}
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
