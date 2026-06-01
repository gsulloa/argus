/**
 * §21.1 — MySQL StructureSubtab.
 *
 * Renders structured view of a MySQL table/view:
 * - Columns (name, column_type, nullable, default, extra, comment)
 * - Primary key (columns + auto_increment badge)
 * - Unique constraints
 * - Foreign keys (ref_schema.ref_table(ref_columns), ON UPDATE/DELETE)
 * - Indexes (sub_part, unique, type badge)
 * - Triggers (timing + event)
 * - Table options (engine, charset, row_format, auto_increment, comment)
 * - Per-section error banner with retry button (§21.4)
 *
 * Calls mysqlApi.tableStructure via useTableStructureCache (§21.3).
 */

import { useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type {
  TableStructureResult,
  TableStructureColumn,
  PrimaryKey,
  UniqueConstraint,
  TableForeignKey,
  TableIndex,
  TableTrigger,
  TableOptions,
  KindFailure,
} from "../types";
import type { TableStructureCache } from "./useTableStructureCache";
import styles from "./StructureSubtab.module.css";

interface Props {
  connectionId: string;
  schema: string;
  relation: string;
  relationKind: "table" | "view";
  cache: TableStructureCache;
}

export function StructureSubtab({
  schema,
  relation,
  relationKind,
  cache,
}: Props) {
  useEffect(() => {
    if (cache.structureState.status === "idle") {
      void cache.ensureStructureLoaded("auto");
    }
  }, [cache]);

  const onRefresh = () => {
    void cache.refreshStructure("user");
  };

  const isLoading =
    cache.structureState.status === "loading" && cache.structureState.response === null;
  const hasError =
    cache.structureState.status === "error" && cache.structureState.response === null;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.title}>
          <span className={styles.relname}>
            {schema}.{relation}
          </span>
          <span className={styles.relkind}>
            {relationKind === "view" ? "View" : "Table"}
          </span>
        </div>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={onRefresh}
          disabled={cache.structureState.status === "loading"}
          aria-label="Refresh structure"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </header>

      {isLoading ? (
        <div className={styles.loading}>
          <Loader2 className={styles.spinner} size={14} />
          Loading structure…
        </div>
      ) : hasError ? (
        <div className={styles.errorBanner} role="alert">
          {cache.structureState.error?.message ?? "Failed to load structure."}
          <button type="button" className={styles.retryBtn} onClick={onRefresh}>
            Retry
          </button>
        </div>
      ) : cache.structureState.response ? (
        <Body
          response={cache.structureState.response}
          isView={relationKind === "view"}
          onRetry={onRefresh}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface BodyProps {
  response: TableStructureResult;
  isView: boolean;
  onRetry(): void;
}

function Body({ response, isView, onRetry }: BodyProps) {
  const failuresByKind = new Map<string, KindFailure>();
  for (const f of response.failures) failuresByKind.set(f.kind, f);

  return (
    <div className={styles.body}>
      {/* Columns — always shown */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Columns</h3>
        <div className={styles.sectionBody}>
          <ColumnsTable
            columns={response.columns}
            primaryKey={response.primary_key}
            autoIncrementColumn={response.primary_key?.auto_increment_column ?? null}
          />
        </div>
      </section>

      {/* Primary key */}
      {!isView && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Primary key</h3>
          <div className={styles.sectionBody}>
            {response.primary_key && response.primary_key.columns.length > 0 ? (
              <PrimaryKeyView pk={response.primary_key} />
            ) : (
              <div className={styles.emptyState}>None.</div>
            )}
          </div>
        </section>
      )}

      {/* Unique constraints */}
      {!isView && (
        <SectionWithFailure
          title="Unique constraints"
          failure={failuresByKind.get("unique_constraints")}
          items={response.unique_constraints}
          onRetry={onRetry}
        >
          {(items) => <UniqueConstraintsTable items={items} />}
        </SectionWithFailure>
      )}

      {/* Foreign keys */}
      {!isView && (
        <SectionWithFailure
          title="Foreign keys"
          failure={failuresByKind.get("foreign_keys")}
          items={response.foreign_keys}
          onRetry={onRetry}
        >
          {(items) => <ForeignKeysTable items={items} />}
        </SectionWithFailure>
      )}

      {/* Indexes */}
      <SectionWithFailure
        title="Indexes"
        failure={failuresByKind.get("indexes")}
        items={response.indexes}
        onRetry={onRetry}
      >
        {(items) => <IndexesTable items={items} />}
      </SectionWithFailure>

      {/* Triggers */}
      <SectionWithFailure
        title="Triggers"
        failure={failuresByKind.get("triggers")}
        items={response.triggers}
        onRetry={onRetry}
      >
        {(items) => <TriggersTable items={items} />}
      </SectionWithFailure>

      {/* Table options — tables only */}
      {!isView && response.table_options && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Table options</h3>
          <div className={styles.sectionBody}>
            <TableOptionsView options={response.table_options} />
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionWithFailure helper
// ---------------------------------------------------------------------------

interface SectionWithFailureProps<T> {
  title: string;
  failure: KindFailure | undefined;
  items: T[] | null;
  onRetry(): void;
  children: (items: T[]) => React.ReactNode;
}

function SectionWithFailure<T>({
  title,
  failure,
  items,
  onRetry,
  children,
}: SectionWithFailureProps<T>) {
  if (failure) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <div className={styles.failureChip}>
          Could not load {title.toLowerCase()} — {failure.message}
          <button type="button" className={styles.retryBtn} onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!items || items.length === 0) {
    return null; // hide empty sections
  }
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <div className={styles.sectionBody}>{children(items)}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Columns table
// ---------------------------------------------------------------------------

function ColumnsTable({
  columns,
  primaryKey,
  autoIncrementColumn,
}: {
  columns: TableStructureColumn[];
  primaryKey: PrimaryKey | null;
  autoIncrementColumn: string | null;
}) {
  const pkCols = new Set(primaryKey?.columns ?? []);
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.colNum}>#</th>
          <th>Name</th>
          <th>Type</th>
          <th className={styles.colFlag}>Nullable</th>
          <th>Default</th>
          <th>Extra</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col) => {
          const isPk = pkCols.has(col.name);
          const isAi = col.name === autoIncrementColumn;
          return (
            <tr key={col.name}>
              <td className={styles.colNum} style={{ color: "var(--text-subtle)" }}>
                {col.ordinal_position}
              </td>
              <td>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {col.name}
                  {isPk ? <span className={`${styles.badge} ${styles.badgePk}`}>PK</span> : null}
                  {isAi ? <span className={`${styles.badge} ${styles.badgeAi}`}>AI</span> : null}
                </span>
              </td>
              <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                {col.column_type}
              </td>
              <td className={styles.colFlag}>
                <span
                  className={
                    col.is_nullable ? styles.nullableYes : styles.nullableNo
                  }
                >
                  {col.is_nullable ? "YES" : "NO"}
                </span>
              </td>
              <td style={{ color: "var(--text-muted)" }}>
                {col.column_default ?? <span style={{ color: "var(--text-subtle)" }}>—</span>}
              </td>
              <td style={{ color: "var(--text-muted)" }}>
                {col.extra ?? ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Primary key view
// ---------------------------------------------------------------------------

function PrimaryKeyView({ pk }: { pk: PrimaryKey }) {
  return (
    <div
      style={{
        padding: "4px 12px 8px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        ({pk.columns.join(", ")})
        {pk.auto_increment_column ? (
          <span className={`${styles.badge} ${styles.badgeAi}`}>
            AUTO_INCREMENT: {pk.auto_increment_column}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unique constraints table
// ---------------------------------------------------------------------------

function UniqueConstraintsTable({ items }: { items: UniqueConstraint[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Columns</th>
        </tr>
      </thead>
      <tbody>
        {items.map((uc) => (
          <tr key={uc.name}>
            <td style={{ fontFamily: "var(--font-mono)" }}>{uc.name}</td>
            <td style={{ fontFamily: "var(--font-mono)" }}>{uc.columns.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Foreign keys table
// ---------------------------------------------------------------------------

function ForeignKeysTable({ items }: { items: TableForeignKey[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Columns</th>
          <th>References</th>
          <th>On Update</th>
          <th>On Delete</th>
        </tr>
      </thead>
      <tbody>
        {items.map((fk) => (
          <tr key={fk.name}>
            <td style={{ fontFamily: "var(--font-mono)" }}>{fk.name}</td>
            <td style={{ fontFamily: "var(--font-mono)" }}>{fk.columns.join(", ")}</td>
            <td style={{ fontFamily: "var(--font-mono)" }}>
              {fk.ref_schema}.{fk.ref_table}({fk.ref_columns.join(", ")})
            </td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {fk.on_update}
            </td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {fk.on_delete}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Indexes table
// ---------------------------------------------------------------------------

function IndexesTable({ items }: { items: TableIndex[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Columns</th>
          <th>Unique</th>
        </tr>
      </thead>
      <tbody>
        {items.map((idx) => (
          <tr key={idx.name}>
            <td style={{ fontFamily: "var(--font-mono)" }}>{idx.name}</td>
            <td>
              <span className={`${styles.badge} ${styles.badgeIndex}`}>
                {idx.index_type}
              </span>
            </td>
            <td style={{ fontFamily: "var(--font-mono)" }}>
              {idx.columns.map((c) => {
                const sub = c.sub_part != null ? `(${c.sub_part})` : "";
                const dir = c.descending ? " DESC" : "";
                return `${c.name}${sub}${dir}`;
              }).join(", ")}
            </td>
            <td>
              {idx.is_unique ? (
                <span className={`${styles.badge} ${styles.badgeUnique}`}>YES</span>
              ) : (
                <span style={{ color: "var(--text-subtle)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  —
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Triggers table
// ---------------------------------------------------------------------------

function TriggersTable({ items }: { items: TableTrigger[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Timing</th>
          <th>Events</th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.name}>
            <td style={{ fontFamily: "var(--font-mono)" }}>{t.name}</td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {t.timing}
            </td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {t.events.join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Table options key-value view
// ---------------------------------------------------------------------------

function TableOptionsView({ options }: { options: TableOptions }) {
  const rows: Array<[string, string | number | null]> = [
    ["Engine", options.engine],
    ["Character set", options.charset],
    ["Collation", options.collation],
    ["Row format", options.row_format],
    ["Auto increment", options.auto_increment],
    ["Comment", options.comment],
  ];
  const defined = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (defined.length === 0) return <div className={styles.emptyState}>None.</div>;
  return (
    <table className={styles.kvTable}>
      <tbody>
        {defined.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{String(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
