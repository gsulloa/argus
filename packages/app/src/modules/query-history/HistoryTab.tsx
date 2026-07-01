import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { useTabs } from "@/platform/shell/tabs/TabsContext";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { openQueryTab } from "@/modules/postgres";
import { openMysqlQueryTab, MYSQL_KIND } from "@/modules/mysql";
import { openMssqlQueryTab } from "@/modules/mssql";
import { MSSQL_KIND } from "@/modules/mssql/types";
import {
  historyApi,
  type DistinctConnection,
  type HistoryEntry,
  type HistoryFilters,
  type HistoryListResponse,
} from "./api";
import styles from "./HistoryTab.module.css";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import { noAutoCorrectProps } from "../shared/text-input-hygiene";
import { writeClipboardText, COPY_FAILED_MESSAGE } from "@/platform/clipboard";
import { useToast } from "@/platform/toast";

export const QUERY_HISTORY_KIND = "query-history";
export const QUERY_HISTORY_TAB_ID = "history";

const ROW_HEIGHT = 44;
const PAGE_SIZE = 200;
const SQL_PREVIEW_MAX_CHARS = 140;
const SEARCH_DEBOUNCE_MS = 200;

type DatePreset = "all" | "today" | "7d" | "30d";

interface UiFilters {
  connectionIds: string[]; // empty = all
  preset: DatePreset;
  search: string;
  errorsOnly: boolean;
}

const INITIAL_FILTERS: UiFilters = {
  connectionIds: [],
  preset: "all",
  search: "",
  errorsOnly: false,
};

function presetToRange(preset: DatePreset): { since?: number; until?: number } {
  if (preset === "all") return {};
  const now = Date.now();
  const day = 86_400_000;
  if (preset === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { since: start.getTime(), until: now };
  }
  if (preset === "7d") return { since: now - 7 * day, until: now };
  if (preset === "30d") return { since: now - 30 * day, until: now };
  return {};
}

function uiFiltersToApi(ui: UiFilters): HistoryFilters {
  const range = presetToRange(ui.preset);
  return {
    connection_ids: ui.connectionIds.length > 0 ? ui.connectionIds : undefined,
    since: range.since,
    until: range.until,
    search: ui.search.trim() || undefined,
    status: ui.errorsOnly ? "err" : undefined,
  };
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = d.toLocaleDateString([], { month: "short", day: "2-digit" });
  return `${time} · ${date}`;
}

function formatSqlPreview(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SQL_PREVIEW_MAX_CHARS) return oneLine;
  return oneLine.slice(0, SQL_PREVIEW_MAX_CHARS - 1) + "…";
}

function describeOutcome(entry: HistoryEntry): { label: string; isErr: boolean } {
  if (entry.status === "err") {
    return { label: `${entry.duration_ms} ms · error`, isErr: true };
  }
  if (entry.row_count != null && entry.command_tag == null) {
    const n = entry.row_count;
    return { label: `${entry.duration_ms} ms · ${n} ${n === 1 ? "row" : "rows"}`, isErr: false };
  }
  if (entry.command_tag != null) {
    return { label: `${entry.duration_ms} ms · ${entry.command_tag}`, isErr: false };
  }
  return { label: `${entry.duration_ms} ms`, isErr: false };
}

function HistoryTabRoot({ tab: _tab }: { tab: Tab; active: boolean }) {
  return <HistoryTab />;
}

interface ConnectionOption {
  id: string;
  name: string;
  deleted: boolean;
}

function HistoryTab() {
  const tabs = useTabs();
  const { items: liveConnections } = useConnections();
  const toast = useToast();

  const [filters, setFilters] = useState<UiFilters>(INITIAL_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [response, setResponse] = useState<HistoryListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [distinctConns, setDistinctConns] = useState<DistinctConnection[]>([]);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // Debounce search input → filter.search.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Build the connection picker options: live connections (postgres only)
  // plus any distinct ids in history that aren't in the live set, marked
  // `(deleted)` and labeled with the snapshotted name.
  const connectionOptions: ConnectionOption[] = useMemo(() => {
    const liveById = new Map(liveConnections.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const opts: ConnectionOption[] = [];
    for (const c of liveConnections) {
      seen.add(c.id);
      opts.push({ id: c.id, name: c.name, deleted: false });
    }
    for (const d of distinctConns) {
      if (seen.has(d.id)) continue;
      // Use the live name if it somehow appeared between fetches; otherwise the snapshot.
      const live = liveById.get(d.id);
      opts.push({
        id: d.id,
        name: live ? live.name : d.name,
        deleted: !live,
      });
      seen.add(d.id);
    }
    opts.sort((a, b) => a.name.localeCompare(b.name));
    return opts;
  }, [liveConnections, distinctConns]);

  function refetchAll() {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      historyApi.list({ ...uiFiltersToApi(filters), limit: PAGE_SIZE, offset: 0 }),
      historyApi.distinctConnections(),
    ])
      .then(([resp, distinct]) => {
        if (cancelled) return;
        setResponse(resp);
        setDistinctConns(distinct);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }

  // Refetch whenever effective filters change.
  useEffect(() => {
    const cancel = refetchAll();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.connectionIds.join(","),
    filters.preset,
    filters.search,
    filters.errorsOnly,
  ]);

  const entries = response?.entries ?? [];
  const total = response?.total ?? 0;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  function toggleConnection(id: string) {
    setFilters((f) => {
      const has = f.connectionIds.includes(id);
      return {
        ...f,
        connectionIds: has ? f.connectionIds.filter((x) => x !== id) : [...f.connectionIds, id],
      };
    });
  }

  function resetFilters() {
    setFilters(INITIAL_FILTERS);
    setSearchInput("");
  }

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  function handleOpenInEditor(entry: HistoryEntry) {
    const live = liveConnections.find((c) => c.id === entry.connection_id);
    if (!live) return; // disabled in UI
    if (live.kind === MYSQL_KIND) {
      openMysqlQueryTab(tabs, {
        connectionId: live.id,
        connectionName: live.name,
        sql: entry.sql,
      });
    } else if (live.kind === MSSQL_KIND) {
      openMssqlQueryTab(tabs, {
        connectionId: live.id,
        connectionName: live.name,
        sql: entry.sql,
      });
    } else {
      openQueryTab(tabs, {
        initialConnectionId: live.id,
        initialConnectionName: live.name,
        initialSql: entry.sql,
      });
    }
  }

  const handleCopySql = (entry: HistoryEntry) => {
    void writeClipboardText(entry.sql).then((ok) => {
      if (!ok) toast.show(COPY_FAILED_MESSAGE, "error");
    });
  };

  async function handleClearConfirm() {
    try {
      await historyApi.clear(uiFiltersToApi(filters));
      setSelectedId(null);
      refetchAll();
    } catch (e) {
      console.error("[argus] clear history failed:", e);
    } finally {
      setConfirmClearOpen(false);
    }
  }

  const hasActiveFilters =
    filters.connectionIds.length > 0 ||
    filters.preset !== "all" ||
    filters.search.trim().length > 0 ||
    filters.errorsOnly;

  const clearLabel = hasActiveFilters
    ? `Delete ${total.toLocaleString()} filtered history entries?`
    : `Delete all ${total.toLocaleString()} history entries?`;

  return (
    <div className={styles.root}>
      <div className={styles.filterBar}>
        <input
          type="search"
          {...noAutoCorrectProps}
          className={styles.search}
          placeholder="Search SQL…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Range</span>
          <select
            className={styles.select}
            value={filters.preset}
            onChange={(e) => setFilters((f) => ({ ...f, preset: e.target.value as DatePreset }))}
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Connections</span>
          <ConnectionMultiSelect
            options={connectionOptions}
            selected={filters.connectionIds}
            onToggle={toggleConnection}
            onClear={() => setFilters((f) => ({ ...f, connectionIds: [] }))}
          />
        </div>

        <button
          type="button"
          className={`${styles.toggle} ${filters.errorsOnly ? styles.toggleActive : ""}`}
          onClick={() => setFilters((f) => ({ ...f, errorsOnly: !f.errorsOnly }))}
          title="Show only errored runs"
        >
          Errors only
        </button>

        <div className={styles.spacer} />

        <button
          type="button"
          className={styles.clearBtn}
          disabled={total === 0}
          onClick={() => setConfirmClearOpen(true)}
        >
          Clear history
        </button>
      </div>

      <div className={styles.statusLine}>
        {loading
          ? "Loading…"
          : error
            ? `Error: ${error}`
            : `${entries.length.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "entry" : "entries"}`}
      </div>

      <div ref={viewportRef} className={styles.viewport}>
        {!loading && entries.length === 0 ? (
          <div className={styles.empty}>
            {hasActiveFilters ? (
              <>
                <span>No matches for the current filters.</span>
                <button className={styles.emptyAction} onClick={resetFilters}>
                  Reset filters
                </button>
              </>
            ) : (
              <span>No SQL has been recorded yet. Run a query to get started.</span>
            )}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = entries[vi.index];
              if (!entry) return null;
              const outcome = describeOutcome(entry);
              const isLive = liveConnections.some((c) => c.id === entry.connection_id);
              return (
                <div
                  key={entry.id}
                  className={`${styles.row} ${selectedId === entry.id ? styles.rowSelected : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                    height: `${vi.size}px`,
                  }}
                  onClick={() => setSelectedId(entry.id)}
                  onDoubleClick={() => isLive && handleOpenInEditor(entry)}
                  title={entry.sql}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isLive) handleOpenInEditor(entry);
                  }}
                >
                  <span className={styles.timestamp}>{formatTimestamp(entry.started_at)}</span>
                  <span
                    className={`${styles.connPill} ${isLive ? "" : styles.connPillDeleted}`}
                  >
                    {entry.connection_name}
                    {!isLive && " (deleted)"}
                  </span>
                  <span className={styles.sqlPreview}>{formatSqlPreview(entry.sql)}</span>
                  <span
                    className={`${styles.outcome} ${outcome.isErr ? styles.outcomeErr : ""}`}
                  >
                    {outcome.label}
                  </span>
                  <span
                    className={`${styles.statusIcon} ${
                      entry.status === "err" ? styles.statusIconErr : styles.statusIconOk
                    }`}
                    aria-label={entry.status === "err" ? "error" : "ok"}
                  >
                    {entry.status === "err" ? "✗" : "✓"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedEntry && (
        <DetailPanel
          entry={selectedEntry}
          isLive={liveConnections.some((c) => c.id === selectedEntry.connection_id)}
          onOpen={() => handleOpenInEditor(selectedEntry)}
          onCopy={() => handleCopySql(selectedEntry)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <Dialog.Root open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogStyles.overlay} />
          <Dialog.Content className={dialogStyles.content}>
            <Dialog.Title className={dialogStyles.title}>Clear history</Dialog.Title>
            <Dialog.Description className={dialogStyles.description}>
              {clearLabel} This cannot be undone.
            </Dialog.Description>
            <div className={dialogStyles.footer}>
              <button onClick={() => setConfirmClearOpen(false)}>Cancel</button>
              <button className={dialogStyles.primary} onClick={handleClearConfirm}>
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function DetailPanel({
  entry,
  isLive,
  onOpen,
  onCopy,
  onClose,
}: {
  entry: HistoryEntry;
  isLive: boolean;
  onOpen: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <span>{formatTimestamp(entry.started_at)}</span>
        <span>
          on <strong>{entry.connection_name}</strong>
          {!isLive && " (deleted)"}
        </span>
        <span>{entry.duration_ms} ms</span>
        <span className={styles.detailActions}>
          <button
            className={`${styles.detailAction} ${styles.detailActionPrimary}`}
            disabled={!isLive}
            onClick={onOpen}
            title={isLive ? "Open in a new query tab" : "Connection no longer registered"}
          >
            Open in editor
          </button>
          <button className={styles.detailAction} onClick={onCopy}>
            Copy SQL
          </button>
          <button className={styles.detailAction} onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      <div className={styles.detailSql}>{entry.sql}</div>
      {entry.status === "err" && (
        <div className={styles.detailErr}>
          {entry.error_code ? `[${entry.error_code}] ` : ""}
          {entry.error_message ?? "(unknown error)"}
        </div>
      )}
    </div>
  );
}

function ConnectionMultiSelect({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: ConnectionOption[];
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedNames = options.filter((o) => selected.includes(o.id)).map((o) => o.name);
  const label =
    selected.length === 0
      ? "All"
      : selected.length === 1
        ? selectedNames[0]
        : `${selected.length} selected`;
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className={styles.select}
        onClick={() => setOpen((v) => !v)}
        style={{ minWidth: 130 }}
      >
        {label}
      </button>
      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 19 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              minWidth: 220,
              maxHeight: 280,
              overflow: "auto",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 4,
              boxShadow: "var(--shadow-md)",
              zIndex: 20,
            }}
          >
            {options.length === 0 && (
              <div style={{ padding: "6px 8px", color: "var(--text-subtle)", fontSize: 11 }}>
                No connections yet.
              </div>
            )}
            {options.map((o) => {
              const checked = selected.includes(o.id);
              return (
                <label
                  key={o.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 6px",
                    fontSize: 12,
                    cursor: "pointer",
                    borderRadius: 3,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(o.id)}
                  />
                  <span style={{ flex: 1 }}>{o.name}</span>
                  {o.deleted && (
                    <span style={{ color: "var(--text-subtle)", fontStyle: "italic" }}>
                      deleted
                    </span>
                  )}
                </label>
              );
            })}
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
                style={{
                  marginTop: 4,
                  width: "100%",
                  padding: "4px 6px",
                  fontSize: 11,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  cursor: "pointer",
                  color: "var(--text-muted)",
                }}
              >
                Clear selection
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

TabRegistry.register(QUERY_HISTORY_KIND, HistoryTabRoot);
