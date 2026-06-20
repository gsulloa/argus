/**
 * ConnectionRail — level-1 navigation strip for the Workspace window.
 *
 * Lists the currently-open connections from `useOpenConnections()`.  Each item
 * shows the engine icon, an environment-color indicator, and the connection
 * name on hover.  The focused item is visually distinguished.  Right-clicking
 * opens a context menu with "Close connection".  A trailing "+" recreates/
 * focuses the Manager window.
 *
 * Decisions implemented here:
 *   Decision 2  — narrow vertical icon strip, one item per open connection.
 *   Decision 4  — clicking an item calls setFocused(id).
 *   spec/connection-rail — all rail requirements.
 */
import { Plus } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { invoke } from "@tauri-apps/api/core";
import {
  POSTGRES_KIND,
  PostgresIcon,
  postgresApi,
} from "@/modules/postgres";
import {
  DYNAMO_KIND,
  DynamoIcon,
  dynamoApi,
} from "@/modules/dynamo";
import {
  MYSQL_KIND,
  MysqlIcon,
  mysqlApi,
} from "@/modules/mysql";
import {
  MSSQL_KIND,
  MssqlIcon,
  mssqlApi,
} from "@/modules/mssql";
import {
  ATHENA_KIND,
  AthenaIcon,
  athenaApi,
} from "@/modules/athena";
import { useOpenConnections } from "@/platform/connection-registry/useOpenConnections";
import { useFocusedConnection } from "./FocusedConnectionContext";
import styles from "./ConnectionRail.module.css";

// ---------------------------------------------------------------------------
// Environment color heuristic
// ---------------------------------------------------------------------------

/**
 * Provisional heuristic: if the connection name contains "prod" (case-
 * insensitive) treat it as a production environment and show a warning-color
 * dot.  Otherwise neutral/local.
 *
 * DESIGN open question: this should eventually be an explicit per-connection
 * field rather than a name heuristic.  See design.md "Open Questions —
 * environment color source".
 */
export function deriveEnv(name: string): "prod" | "neutral" {
  return /prod/i.test(name) ? "prod" : "neutral";
}

// ---------------------------------------------------------------------------
// Engine icon
// ---------------------------------------------------------------------------

/** Human-readable label for an engine kind. */
export function engineLabel(kind: string): string {
  if (kind === POSTGRES_KIND) return "PostgreSQL";
  if (kind === DYNAMO_KIND) return "DynamoDB";
  if (kind === MYSQL_KIND) return "MySQL";
  if (kind === MSSQL_KIND) return "SQL Server";
  if (kind === ATHENA_KIND) return "Athena";
  return kind;
}

export function EngineIcon({ kind }: { kind: string }) {
  if (kind === POSTGRES_KIND) return <PostgresIcon size={16} />;
  if (kind === DYNAMO_KIND) return <DynamoIcon size={16} />;
  if (kind === MYSQL_KIND) return <MysqlIcon size={16} />;
  if (kind === MSSQL_KIND) return <MssqlIcon size={16} />;
  if (kind === ATHENA_KIND) return <AthenaIcon size={16} />;
  // Fallback: first two chars of kind as text
  return <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.04em" }}>{kind.slice(0, 2)}</span>;
}

// ---------------------------------------------------------------------------
// Per-engine disconnect
// ---------------------------------------------------------------------------

async function disconnectConnection(id: string, kind: string): Promise<void> {
  try {
    if (kind === POSTGRES_KIND) {
      await postgresApi.disconnect(id);
    } else if (kind === DYNAMO_KIND) {
      await dynamoApi.disconnect(id);
    } else if (kind === MYSQL_KIND) {
      await mysqlApi.disconnect(id);
    } else if (kind === MSSQL_KIND) {
      await mssqlApi.disconnect(id);
    } else if (kind === ATHENA_KIND) {
      await athenaApi.disconnect(id);
    }
  } catch (e) {
    console.error("[argus] ConnectionRail disconnect:", e);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectionRail() {
  const { items } = useOpenConnections();
  const { focusedConnectionId, setFocused } = useFocusedConnection();

  async function handleClose(id: string, kind: string) {
    await disconnectConnection(id, kind);
    // If this was the focused connection, the FocusedConnectionProvider will
    // automatically move focus to a neighbor when it receives the updated
    // open list via connections:open-changed.
  }

  async function handleAddClick() {
    try {
      await invoke("ensure_manager_window");
    } catch (e) {
      console.error("[argus] ConnectionRail ensure_manager_window:", e);
    }
  }

  return (
    <nav className={styles.rail} aria-label="Open connections">
      {items.map((conn) => {
        const env = deriveEnv(conn.name);
        const isFocused = conn.id === focusedConnectionId;
        return (
          <ContextMenu.Root key={conn.id}>
            <ContextMenu.Trigger asChild>
              <button
                type="button"
                className={styles.item}
                data-focused={isFocused ? "true" : undefined}
                title={conn.name}
                aria-label={conn.name}
                aria-pressed={isFocused}
                onClick={() => setFocused(conn.id)}
              >
                <EngineIcon kind={conn.kind} />
                <span className={styles.itemLabel}>{conn.name}</span>
                <span className={styles.envDot} data-env={env} aria-hidden="true" />
              </button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={styles.contextMenu}>
                <ContextMenu.Item
                  className={`${styles.contextItem} ${styles.contextItemDanger}`}
                  onSelect={() => void handleClose(conn.id, conn.kind)}
                >
                  Close connection
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}

      {/* Trailing "+" affordance — opens/focuses the Manager window */}
      <button
        type="button"
        className={styles.addButton}
        title="Open Connection Manager"
        aria-label="Open Connection Manager"
        onClick={() => void handleAddClick()}
      >
        <Plus size={14} strokeWidth={2} />
      </button>
    </nav>
  );
}
