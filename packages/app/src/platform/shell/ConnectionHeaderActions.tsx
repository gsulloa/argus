/**
 * ConnectionHeaderActions — renders the focused connection's per-engine
 * contextual actions (new query, refresh, visible-schemas picker) for the
 * Workspace identity header, dispatched by connection kind.
 *
 * Reuses each engine's existing action components unchanged. Engine kinds
 * without defined header actions (e.g. cloudwatch) render nothing.
 *
 * Parallel to ConnectionSubtree (which dispatches the schema tree).
 */
import { useConnections } from "@/platform/connection-registry/useConnections";
import { POSTGRES_KIND, SchemaPrimaryActions, SchemaToolbar } from "@/modules/postgres";
import { MYSQL_KIND, MysqlSchemaPrimaryActions, MysqlSchemaToolbar } from "@/modules/mysql";
import { MSSQL_KIND, MssqlSchemaPrimaryActions, MssqlSchemaToolbar } from "@/modules/mssql";
import { ATHENA_KIND, AthenaSchemaPrimaryActions, AthenaSchemaToolbar } from "@/modules/athena";
import { DYNAMO_KIND } from "@/modules/dynamo";
import { DynamoRefreshButton } from "@/modules/dynamo/tables";

interface Props {
  connectionId: string;
}

export function ConnectionHeaderActions({ connectionId }: Props) {
  const { items } = useConnections();
  const connection = items.find((c) => c.id === connectionId);
  if (!connection) return null;

  switch (connection.kind) {
    case POSTGRES_KIND:
      return (
        <>
          <SchemaPrimaryActions connectionId={connectionId} />
          <SchemaToolbar connectionId={connectionId} />
        </>
      );
    case MYSQL_KIND:
      return (
        <>
          <MysqlSchemaPrimaryActions connectionId={connectionId} />
          <MysqlSchemaToolbar connectionId={connectionId} />
        </>
      );
    case MSSQL_KIND:
      return (
        <>
          <MssqlSchemaPrimaryActions connectionId={connectionId} />
          <MssqlSchemaToolbar connectionId={connectionId} />
        </>
      );
    case ATHENA_KIND:
      return (
        <>
          <AthenaSchemaPrimaryActions connectionId={connectionId} />
          <AthenaSchemaToolbar connectionId={connectionId} />
        </>
      );
    case DYNAMO_KIND:
      return <DynamoRefreshButton connectionId={connectionId} />;
    default:
      return null;
  }
}
