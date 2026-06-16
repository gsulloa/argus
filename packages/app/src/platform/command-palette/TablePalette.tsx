import { Command as Cmdk } from "cmdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTabs } from "@/platform/shell/tabs";
import { useActiveConnections } from "@/modules/postgres/useActiveConnections";
import { useActiveMysqlConnections } from "@/modules/mysql/useActiveConnections";
import { useActiveMssqlConnections } from "@/modules/mssql/useActiveConnections";
import { openObjectTab } from "@/modules/postgres/schema/openObjectTab";
import { openMysqlObjectTab } from "@/modules/mysql/schema/openObjectTab";
import { openMssqlObjectTab } from "@/modules/mssql/schema/openObjectTab";
import type { RelationKind } from "@/modules/postgres/data/types";
import { PaletteShell, type PaletteFilter } from "./PaletteShell";
import { useTablePalette } from "./PaletteContext";
import { useTableIndex, type TableEntry } from "./useTableIndex";
import { useRecentTables } from "./useRecentTables";
import { scoreTableEntry } from "./scoreTableEntry";
import paletteStyles from "./Palette.module.css";
import styles from "./TablePalette.module.css";

const KIND_GLYPH: Record<RelationKind, string> = {
  table: "T",
  view: "V",
  "materialized-view": "M",
};

/** RelationKind → `PostgresObjectPlaceholderPayload.kind` string. */
const KIND_PAYLOAD: Record<RelationKind, "table" | "view" | "materialized_view"> = {
  table: "table",
  view: "view",
  "materialized-view": "materialized_view",
};

function entryKey(e: TableEntry): string {
  return `${e.connectionId}:${e.schema}:${e.name}`;
}

interface RowProps {
  entry: TableEntry;
  /** Cmdk requires unique values across visible items. The "Recent" group
   *  prefixes its values to avoid collisions when the same entry is also
   *  visible in the "Tables" group below. */
  valuePrefix?: string;
  onSelect: (entry: TableEntry) => void;
}

function TableRow({ entry, valuePrefix = "", onSelect }: RowProps) {
  const value = `${valuePrefix}${entry.schema}.${entry.name} ${entry.connectionName}`;
  return (
    <Cmdk.Item
      value={value}
      keywords={[entry.schema, entry.name, entry.connectionName, entry.kind]}
      className={styles.row}
      onSelect={() => onSelect(entry)}
    >
      <span className={styles.kindGlyph}>{KIND_GLYPH[entry.kind]}</span>
      <span className={styles.relation}>
        {entry.schema}.{entry.name}
      </span>
      <span className={styles.connectionName}>{entry.connectionName}</span>
    </Cmdk.Item>
  );
}

export function TablePalette() {
  const { open, hide } = useTablePalette();
  const tabs = useTabs();
  const { items: pgActives } = useActiveConnections();
  const { items: myActives } = useActiveMysqlConnections();
  const { items: msActives } = useActiveMssqlConnections();
  const actives = useMemo(() => [...pgActives, ...myActives, ...msActives], [pgActives, myActives, msActives]);
  const entries = useTableIndex(open);
  const { recents, push: pushRecent } = useRecentTables();
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const activeIds = useMemo(() => new Set(actives.map((a) => a.id)), [actives]);
  const visibleRecents = useMemo(
    () => recents.filter((r) => activeIds.has(r.connectionId)),
    [recents, activeIds],
  );

  const hasConnections = actives.length > 0;
  const indexLoading = hasConnections && entries.length === 0;
  const showRecents = search === "" && visibleRecents.length > 0;

  const tableFilter = useCallback<PaletteFilter>((_value, queryStr, keywords) => {
    const schema = keywords?.[0];
    const name = keywords?.[1];
    const connectionName = keywords?.[2];
    if (schema === undefined || name === undefined || connectionName === undefined) {
      return 0;
    }
    return scoreTableEntry(queryStr, { schema, name, connectionName });
  }, []);

  function handleSelect(entry: TableEntry) {
    hide();
    pushRecent(entry);
    if ((entry.connectionKind ?? "postgres") === "mysql") {
      openMysqlObjectTab(tabs, {
        connectionId: entry.connectionId,
        connectionName: entry.connectionName,
        schema: entry.schema,
        name: entry.name,
        kind: entry.kind === "view" ? "view" : "table",
      });
    } else if (entry.connectionKind === "mssql") {
      openMssqlObjectTab(tabs, {
        connectionId: entry.connectionId,
        connectionName: entry.connectionName,
        schema: entry.schema,
        name: entry.name,
        kind: entry.kind === "view" ? "view" : "table",
      });
    } else {
      openObjectTab(tabs, {
        connectionId: entry.connectionId,
        connectionName: entry.connectionName,
        schema: entry.schema,
        name: entry.name,
        kind: KIND_PAYLOAD[entry.kind],
      });
    }
  }

  return (
    <PaletteShell
      open={open}
      onOpenChange={(v) => !v && hide()}
      title="Jump to table"
      ariaLabel="Table quick switcher"
      placeholder={hasConnections ? "Jump to table…" : "No active connections"}
      search={search}
      onSearchChange={setSearch}
      shouldFilter={hasConnections && entries.length > 0 && search.length > 0}
      filter={tableFilter}
    >
      {!hasConnections ? (
        <div className={paletteStyles.empty}>
          No active connections — open one to search tables.
        </div>
      ) : indexLoading ? (
        <div className={paletteStyles.empty}>Loading tables…</div>
      ) : (
        <>
          <Cmdk.Empty>
            <div className={paletteStyles.empty}>No matching tables</div>
          </Cmdk.Empty>
          {showRecents && (
            <Cmdk.Group heading="Recent" className={paletteStyles.group}>
              {visibleRecents.map((r) => (
                <TableRow
                  key={`recent-${entryKey(r)}`}
                  entry={r}
                  valuePrefix="__recent "
                  onSelect={handleSelect}
                />
              ))}
            </Cmdk.Group>
          )}
          <Cmdk.Group heading="Tables" className={paletteStyles.group}>
            {entries.map((e) => (
              <TableRow
                key={`table-${entryKey(e)}`}
                entry={e}
                onSelect={handleSelect}
              />
            ))}
          </Cmdk.Group>
        </>
      )}
    </PaletteShell>
  );
}
