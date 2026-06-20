import * as React from "react";
import { ConnectionKindPicker, type KindCard } from "./ConnectionKindPicker";
import { usePostgresForm } from "@/modules/postgres";
import { useDynamoForm, DynamoIcon } from "@/modules/dynamo";
import { POSTGRES_KIND } from "@/modules/postgres/types";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import { PostgresIcon } from "@/modules/postgres/icon";
import { useMysqlForm, MysqlIcon, MYSQL_KIND } from "@/modules/mysql";
import { useMssqlForm, MssqlIcon, MSSQL_KIND } from "@/modules/mssql";
import { useAthenaForm, AthenaIcon, ATHENA_KIND } from "@/modules/athena";
import { useCloudwatchForm, CloudwatchIcon, CLOUDWATCH_KIND } from "@/modules/cloudwatch";

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
  const my = useMysqlForm();
  const ms = useMssqlForm();
  const at = useAthenaForm();
  const cw = useCloudwatchForm();

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
        kind: MYSQL_KIND,
        label: "MySQL / MariaDB",
        description: "Connect to a MySQL or MariaDB database",
        Icon: MysqlIcon,
        onPick: () => my.openCreate(),
      },
      {
        kind: MSSQL_KIND,
        label: "Microsoft SQL Server",
        description: "Connect to SQL Server, Azure SQL Database, or Managed Instance",
        Icon: MssqlIcon,
        onPick: () => ms.openCreate(),
      },
      {
        kind: DYNAMO_KIND,
        label: "DynamoDB",
        description: "Connect to AWS DynamoDB",
        Icon: DynamoIcon,
        onPick: () => dy.openCreate(),
      },
      {
        kind: ATHENA_KIND,
        label: "Amazon Athena",
        description: "Connect to AWS Athena (query S3 via Glue)",
        Icon: AthenaIcon,
        onPick: () => at.openCreate(),
      },
      {
        kind: CLOUDWATCH_KIND,
        label: "CloudWatch Logs",
        description: "Browse and query Amazon CloudWatch Logs",
        Icon: CloudwatchIcon,
        onPick: () => cw.openCreate(),
      },
    ],
    [pg, my, ms, dy, at, cw],
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
