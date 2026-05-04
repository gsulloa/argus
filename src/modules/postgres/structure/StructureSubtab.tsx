import { useEffect, useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { useTabs } from "@/platform/shell/tabs";
import { openObjectTab } from "../schema/openObjectTab";
import type {
  CheckConstraintInfo,
  ColumnDetail,
  ForeignKeyInfo,
  IndexInfo,
  KindFailure,
  Relkind,
  TableStructureResult,
  TriggerInfo,
  UniqueConstraintInfo,
} from "../schema/types";
import type { TableStructureCache } from "./useTableStructureCache";
import styles from "./StructureSubtab.module.css";

interface Props {
  tabs: ReturnType<typeof useTabs>;
  connectionId: string;
  connectionName: string;
  schema: string;
  relation: string;
  relkind: Relkind;
  cache: TableStructureCache;
}

export function StructureSubtab({
  tabs,
  connectionId,
  connectionName,
  schema,
  relation,
  relkind,
  cache,
}: Props) {
  useEffect(() => {
    if (cache.state.status === "idle") {
      void cache.ensureLoaded("user");
    }
  }, [cache]);

  const onRefresh = () => {
    void cache.refresh("user");
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.title}>
          <span className={styles.relname}>
            {schema}.{relation}
          </span>
          <span className={styles.relkind}>{relkindLabel(relkind)}</span>
        </div>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={onRefresh}
          disabled={cache.state.status === "loading"}
          aria-label="Refresh structure"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </header>
      {cache.state.status === "loading" && cache.state.response === null ? (
        <div className={styles.loading}>
          <Loader2 className={styles.spinner} size={14} />
          Loading structure…
        </div>
      ) : cache.state.status === "error" && cache.state.response === null ? (
        <div className={styles.errorBanner} role="alert">
          {cache.state.error?.message ?? "Failed to load structure."}
          <button type="button" className={styles.retryBtn} onClick={onRefresh}>
            Retry
          </button>
        </div>
      ) : cache.state.response ? (
        <Body
          tabs={tabs}
          connectionId={connectionId}
          connectionName={connectionName}
          response={cache.state.response}
          onRetry={onRefresh}
        />
      ) : null}
    </div>
  );
}

function relkindLabel(k: Relkind): string {
  switch (k) {
    case "table":
      return "Table";
    case "view":
      return "View";
    case "materialized-view":
      return "Materialized view";
  }
}

interface BodyProps {
  tabs: ReturnType<typeof useTabs>;
  connectionId: string;
  connectionName: string;
  response: TableStructureResult;
  onRetry(): void;
}

function Body({ tabs, connectionId, connectionName, response, onRetry }: BodyProps) {
  const failuresByKind = useMemo(() => {
    const m = new Map<string, KindFailure>();
    for (const f of response.failures) m.set(f.kind, f);
    return m;
  }, [response.failures]);

  const isView = response.relkind !== "table";

  const fkColumnIndex = useMemo(() => {
    const m = new Map<string, ForeignKeyInfo>();
    for (const fk of response.foreign_keys ?? []) {
      for (const col of fk.columns) {
        if (!m.has(col)) m.set(col, fk);
      }
    }
    return m;
  }, [response.foreign_keys]);

  const pkColumns = new Set(response.primary_key?.columns ?? []);

  return (
    <div className={styles.body}>
      <Section title="Columns">
        <ColumnsTable
          tabs={tabs}
          connectionId={connectionId}
          connectionName={connectionName}
          columns={response.columns}
          pkColumns={pkColumns}
          fkByColumn={fkColumnIndex}
        />
      </Section>

      <SectionWithFailure
        title="Indexes"
        failure={failuresByKind.get("indexes")}
        items={response.indexes}
        onRetry={onRetry}
        emptyHidden={!isView}
      >
        {(items) => <IndexesTable items={items} />}
      </SectionWithFailure>

      <SectionWithFailure
        title="Foreign keys"
        failure={failuresByKind.get("foreign_keys")}
        items={response.foreign_keys}
        onRetry={onRetry}
        emptyHidden={!isView}
        viewEmptyState={isView}
      >
        {(items) => (
          <ForeignKeysTable
            tabs={tabs}
            connectionId={connectionId}
            connectionName={connectionName}
            items={items}
          />
        )}
      </SectionWithFailure>

      <SectionWithFailure
        title="Unique constraints"
        failure={failuresByKind.get("unique_constraints")}
        items={response.unique_constraints}
        onRetry={onRetry}
        emptyHidden={!isView}
        viewEmptyState={isView}
      >
        {(items) => <UniqueConstraintsTable items={items} />}
      </SectionWithFailure>

      <SectionWithFailure
        title="Check constraints"
        failure={failuresByKind.get("check_constraints")}
        items={response.check_constraints}
        onRetry={onRetry}
        emptyHidden={!isView}
        viewEmptyState={isView}
      >
        {(items) => <CheckConstraintsTable items={items} />}
      </SectionWithFailure>

      <SectionWithFailure
        title="Triggers"
        failure={failuresByKind.get("triggers")}
        items={response.triggers}
        onRetry={onRetry}
        emptyHidden={!isView}
      >
        {(items) => <TriggersTable items={items} />}
      </SectionWithFailure>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

interface SectionWithFailureProps<T> {
  title: string;
  failure: KindFailure | undefined;
  items: T[] | null;
  onRetry(): void;
  emptyHidden: boolean;
  viewEmptyState?: boolean;
  children: (items: T[]) => React.ReactNode;
}

function SectionWithFailure<T>({
  title,
  failure,
  items,
  onRetry,
  emptyHidden,
  viewEmptyState,
  children,
}: SectionWithFailureProps<T>) {
  if (failure) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <div className={styles.failureChip}>
          Couldn&apos;t load {title.toLowerCase()} — {failure.message}
          <button type="button" className={styles.retryBtn} onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (viewEmptyState) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <div className={styles.emptyState}>
          Views do not declare constraints — see the underlying tables.
        </div>
      </section>
    );
  }
  if (!items || items.length === 0) {
    if (emptyHidden) return null;
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <div className={styles.emptyState}>None.</div>
      </section>
    );
  }
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <div className={styles.sectionBody}>{children(items)}</div>
    </section>
  );
}

function ColumnsTable({
  tabs,
  connectionId,
  connectionName,
  columns,
  pkColumns,
  fkByColumn,
}: {
  tabs: ReturnType<typeof useTabs>;
  connectionId: string;
  connectionName: string;
  columns: ColumnDetail[];
  pkColumns: Set<string>;
  fkByColumn: Map<string, ForeignKeyInfo>;
}) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.colNum}>#</th>
          <th>Name</th>
          <th>Type</th>
          <th className={styles.colFlag}>Nullable</th>
          <th>Default</th>
          <th className={styles.colFlag}>PK</th>
          <th>FK</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((c) => {
          const fk = fkByColumn.get(c.name);
          return (
            <tr key={c.ordinal_position}>
              <td className={styles.numeric}>{c.ordinal_position}</td>
              <td className={styles.mono}>{c.name}</td>
              <td className={styles.mono}>{c.data_type}</td>
              <td className={styles.colFlag}>{c.is_nullable ? "✓" : "—"}</td>
              <td className={styles.mono}>{c.default ?? "—"}</td>
              <td className={styles.colFlag}>
                {pkColumns.has(c.name) ? "✓" : "—"}
              </td>
              <td>
                {fk ? (
                  <button
                    type="button"
                    className={styles.fkChip}
                    title={`References ${fk.references.schema}.${fk.references.relation}`}
                    onClick={() =>
                      openObjectTab(tabs, {
                        connectionId,
                        connectionName,
                        schema: fk.references.schema,
                        kind: "table",
                        name: fk.references.relation,
                      })
                    }
                  >
                    → {fk.references.schema}.{fk.references.relation}
                  </button>
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </td>
              <td>{c.comment ?? <span className={styles.muted}>—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function IndexesTable({ items }: { items: IndexInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Method</th>
          <th className={styles.colFlag}>Unique</th>
          <th className={styles.colFlag}>Primary</th>
        </tr>
      </thead>
      <tbody>
        {items.map((ix) => (
          <tr key={ix.name}>
            <td className={styles.mono}>{ix.name}</td>
            <td className={styles.mono}>{ix.method}</td>
            <td className={styles.colFlag}>{ix.is_unique ? "✓" : "—"}</td>
            <td className={styles.colFlag}>{ix.is_primary ? "✓" : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ForeignKeysTable({
  tabs,
  connectionId,
  connectionName,
  items,
}: {
  tabs: ReturnType<typeof useTabs>;
  connectionId: string;
  connectionName: string;
  items: ForeignKeyInfo[];
}) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Columns</th>
          <th>→ References</th>
          <th>On delete</th>
          <th>On update</th>
        </tr>
      </thead>
      <tbody>
        {items.map((fk) => (
          <tr key={fk.name}>
            <td className={styles.mono}>{fk.name}</td>
            <td className={styles.mono}>{fk.columns.join(", ")}</td>
            <td>
              <button
                type="button"
                className={styles.fkChip}
                onClick={() =>
                  openObjectTab(tabs, {
                    connectionId,
                    connectionName,
                    schema: fk.references.schema,
                    kind: "table",
                    name: fk.references.relation,
                  })
                }
              >
                {fk.references.schema}.{fk.references.relation}
                ({fk.references.columns.join(", ")})
              </button>
            </td>
            <td>{actionLabel(fk.on_delete)}</td>
            <td>{actionLabel(fk.on_update)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function actionLabel(a: ForeignKeyInfo["on_delete"]): string {
  switch (a) {
    case "no_action":
      return "NO ACTION";
    case "restrict":
      return "RESTRICT";
    case "cascade":
      return "CASCADE";
    case "set_null":
      return "SET NULL";
    case "set_default":
      return "SET DEFAULT";
  }
}

function UniqueConstraintsTable({ items }: { items: UniqueConstraintInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Columns</th>
        </tr>
      </thead>
      <tbody>
        {items.map((u) => (
          <tr key={u.name}>
            <td className={styles.mono}>{u.name}</td>
            <td className={styles.mono}>{u.columns.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CheckConstraintsTable({ items }: { items: CheckConstraintInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Expression</th>
        </tr>
      </thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.name}>
            <td className={styles.mono}>{c.name}</td>
            <td className={styles.mono}>{c.expression}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TriggersTable({ items }: { items: TriggerInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Timing</th>
          <th>Events</th>
          <th>Function</th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.name}>
            <td className={styles.mono}>{t.name}</td>
            <td>{timingLabel(t.timing)}</td>
            <td>{t.events.map((e) => e.toUpperCase()).join(", ")}</td>
            <td className={styles.mono}>{t.function}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function timingLabel(t: TriggerInfo["timing"]): string {
  switch (t) {
    case "before":
      return "Before";
    case "after":
      return "After";
    case "instead_of":
      return "Instead Of";
  }
}
