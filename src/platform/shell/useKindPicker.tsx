import * as React from "react";
import { ConnectionKindPicker, type KindCard } from "./ConnectionKindPicker";
import { usePostgresForm } from "@/modules/postgres";
import { useDynamoForm, DynamoIcon } from "@/modules/dynamo";
import { POSTGRES_KIND } from "@/modules/postgres/types";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import { PostgresIcon } from "@/modules/postgres/icon";

interface KindPickerControllerValue {
  open: () => void;
  close: () => void;
}

const Ctx = React.createContext<KindPickerControllerValue | null>(null);

export function KindPickerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const pg = usePostgresForm();
  const dy = useDynamoForm();

  const kinds = React.useMemo<KindCard[]>(
    () => [
      {
        kind: POSTGRES_KIND,
        label: "PostgreSQL",
        description: "Connect to a Postgres database",
        Icon: PostgresIcon,
        onPick: () => pg.openCreate(),
      },
      {
        kind: DYNAMO_KIND,
        label: "DynamoDB",
        description: "Connect to AWS DynamoDB",
        Icon: DynamoIcon,
        onPick: () => dy.openCreate(),
      },
    ],
    [pg, dy],
  );

  const value = React.useMemo<KindPickerControllerValue>(
    () => ({
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
    }),
    [],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <ConnectionKindPicker open={isOpen} onOpenChange={setIsOpen} kinds={kinds} />
    </Ctx.Provider>
  );
}

export function useKindPicker(): KindPickerControllerValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error("useKindPicker must be used inside KindPickerProvider");
  }
  return ctx;
}
