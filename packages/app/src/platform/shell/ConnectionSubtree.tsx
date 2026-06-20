/**
 * ConnectionSubtree — renders the per-engine schema tree + context-queries
 * branch for a single connection, identified by id.
 *
 * This is the Workspace level-2 tree host (Decision 9).  The mount condition
 * has shifted from "this row is active in the old sidebar" to "this connection
 * is focused in the Workspace".  The per-engine subtree components themselves
 * are reused unchanged.
 *
 * Used by WorkspaceShell; NOT used by ConnectionRow (which keeps its own
 * inline workspace-mode subtree path unchanged so existing tests pass).
 */
import { useConnections } from "@/platform/connection-registry/useConnections";
import {
  POSTGRES_KIND,
  SchemaTree,
} from "@/modules/postgres";
import {
  MYSQL_KIND,
  MysqlSchemaTree,
} from "@/modules/mysql";
import {
  MSSQL_KIND,
  MssqlSchemaTree,
} from "@/modules/mssql";
import {
  DYNAMO_KIND,
} from "@/modules/dynamo";
import { DynamoConnectionSubtree } from "@/modules/dynamo/tables";
import {
  ATHENA_KIND,
  AthenaSchemaTree,
} from "@/modules/athena";
import { ContextQueriesBranch } from "@/modules/context/components/ContextQueriesBranch";
import { openContextQuery } from "@/modules/context/openContextQuery";
import { useTabs } from "@/platform/shell/tabs";
import sidebarStyles from "./Sidebar.module.css";

interface Props {
  connectionId: string;
}

/**
 * Renders the full per-engine subtree for the given connection id.
 * Reads the connection record (name, kind, context_path) from the
 * ConnectionsProvider so callers only pass an id.
 *
 * Returns null when the connectionId is not found (race with deletion).
 */
export function ConnectionSubtree({ connectionId }: Props) {
  const { items } = useConnections();
  const tabs = useTabs();

  const connection = items.find((c) => c.id === connectionId);
  if (!connection) return null;

  const { kind, name, context_path } = connection;

  const isPostgres = kind === POSTGRES_KIND;
  const isMySQL = kind === MYSQL_KIND;
  const isMssql = kind === MSSQL_KIND;
  const isDynamo = kind === DYNAMO_KIND;
  const isAthena = kind === ATHENA_KIND;

  return (
    <>
      {isPostgres && (
        <div className={sidebarStyles.subtree}>
          <SchemaTree connectionId={connectionId} />
          <ContextQueriesBranch
            connectionId={connectionId}
            connectionName={name}
            contextPath={context_path}
            engine="postgres"
            onActivate={(q) => {
              void openContextQuery(tabs, connectionId, name, "postgres", q);
            }}
          />
        </div>
      )}
      {isMySQL && (
        <div className={sidebarStyles.subtree}>
          <MysqlSchemaTree connectionId={connectionId} />
          <ContextQueriesBranch
            connectionId={connectionId}
            connectionName={name}
            contextPath={context_path}
            engine="mysql"
            onActivate={(q) => {
              void openContextQuery(tabs, connectionId, name, "mysql", q);
            }}
          />
        </div>
      )}
      {isMssql && (
        <div className={sidebarStyles.subtree}>
          <MssqlSchemaTree connectionId={connectionId} />
          <ContextQueriesBranch
            connectionId={connectionId}
            connectionName={name}
            contextPath={context_path}
            engine="mssql"
            onActivate={(q) => {
              void openContextQuery(tabs, connectionId, name, "mssql", q);
            }}
          />
        </div>
      )}
      {isDynamo && (
        <div className={sidebarStyles.subtree}>
          <DynamoConnectionSubtree connectionId={connectionId} connectionName={name} />
          <ContextQueriesBranch
            connectionId={connectionId}
            connectionName={name}
            contextPath={context_path}
            engine="dynamo"
            onActivate={(q) => {
              void openContextQuery(tabs, connectionId, name, "dynamo", q);
            }}
          />
        </div>
      )}
      {isAthena && (
        <div className={sidebarStyles.subtree}>
          <AthenaSchemaTree connectionId={connectionId} />
          {/* Athena does not use ContextQueriesBranch — matches ConnectionRow behavior */}
        </div>
      )}
    </>
  );
}
