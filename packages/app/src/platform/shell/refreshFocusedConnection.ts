/**
 * Routes a forced schema/table reload to the engine of the focused connection.
 *
 * Each engine exposes its own `refreshConnection(connectionId)` that drops the
 * connection's cache entry and re-fetches — the same path as its tree refresh
 * button. This dispatcher is the single place the global `Cmd+R` / `Ctrl+R`
 * accelerator calls; it picks the right engine by connection kind.
 */

import { POSTGRES_KIND, refreshConnection as refreshPostgres } from "@/modules/postgres";
import { MYSQL_KIND, refreshConnection as refreshMysql } from "@/modules/mysql";
import { MSSQL_KIND, refreshConnection as refreshMssql } from "@/modules/mssql";
import { ATHENA_KIND, refreshConnection as refreshAthena } from "@/modules/athena";
import { DYNAMO_KIND } from "@/modules/dynamo";
import { refreshConnection as refreshDynamo } from "@/modules/dynamo/tables";

/**
 * Refresh the focused connection's schema/table tree. No-op for an unknown
 * kind. Returns true when a refresh path was dispatched.
 */
export function refreshFocusedConnection(connectionId: string, kind: string): boolean {
  switch (kind) {
    case POSTGRES_KIND:
      refreshPostgres(connectionId);
      return true;
    case MYSQL_KIND:
      refreshMysql(connectionId);
      return true;
    case MSSQL_KIND:
      refreshMssql(connectionId);
      return true;
    case ATHENA_KIND:
      refreshAthena(connectionId);
      return true;
    case DYNAMO_KIND:
      refreshDynamo(connectionId);
      return true;
    default:
      return false;
  }
}
