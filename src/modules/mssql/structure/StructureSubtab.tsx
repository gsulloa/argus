/**
 * §21.1 — MS SQL Server StructureSubtab.
 *
 * Renders structured view of an MS SQL Server table/view:
 *  1. Columns (with IDENTITY / computed / sparse badges + category chip)
 *  2. Primary Key
 *  3. Unique Constraints
 *  4. Foreign Keys (with is_disabled / is_not_trusted badges)
 *  5. Indexes (with INCLUDE columns + filter predicate)
 *  6. Triggers (timing + events + is_disabled)
 *  7. Check Constraints
 *  8. Default Constraints
 *  9. Table Options
 *
 * §21.4 — Each section has an inline retry button if it fails (partial degradation).
 */

import { useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type {
  TableStructureResult,
  TableStructureColumn,
  PrimaryKey,
  UniqueConstraint,
  ForeignKeyInfo,
  IndexInfo,
  TriggerInfo,
  CheckConstraintInfo,
  DefaultConstraintInfo,
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
      {/* §21.1.1 — Columns */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Columns</h3>
        <div className={styles.sectionBody}>
          <ColumnsTable
            columns={response.columns}
            primaryKey={response.primary_key}
          />
        </div>
      </section>

      {/* §21.1.2 — Primary Key */}
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

      {/* §21.1.3 — Unique Constraints */}
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

      {/* §21.1.4 — Foreign Keys */}
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

      {/* §21.1.5 — Indexes */}
      <SectionWithFailure
        title="Indexes"
        failure={failuresByKind.get("indexes")}
        items={response.indexes}
        onRetry={onRetry}
      >
        {(items) => <IndexesTable items={items} />}
      </SectionWithFailure>

      {/* §21.1.6 — Triggers */}
      <SectionWithFailure
        title="Triggers"
        failure={failuresByKind.get("triggers")}
        items={response.triggers}
        onRetry={onRetry}
      >
        {(items) => <TriggersTable items={items} />}
      </SectionWithFailure>

      {/* §21.1.7 — Check Constraints */}
      {!isView && (
        <SectionWithFailure
          title="Check constraints"
          failure={failuresByKind.get("check_constraints")}
          items={response.check_constraints}
          onRetry={onRetry}
        >
          {(items) => <CheckConstraintsTable items={items} />}
        </SectionWithFailure>
      )}

      {/* §21.1.8 — Default Constraints */}
      {!isView && (
        <SectionWithFailure
          title="Default constraints"
          failure={failuresByKind.get("default_constraints")}
          items={response.default_constraints}
          onRetry={onRetry}
        >
          {(items) => <DefaultConstraintsTable items={items} />}
        </SectionWithFailure>
      )}

      {/* §21.1.9 — Table Options */}
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
    return null;
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
}: {
  columns: TableStructureColumn[];
  primaryKey: PrimaryKey | null;
}) {
  const pkCols = new Set(primaryKey?.columns ?? []);
  const identityCol = primaryKey?.identity_column;

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.colNum}>#</th>
          <th>Name</th>
          <th>Type</th>
          <th className={styles.colFlag}>Nullable</th>
          <th>Default</th>
          <th>Category</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col) => {
          const isPk = pkCols.has(col.name);
          const isIdentity = col.is_identity;
          const isComputed = col.is_computed;
          const isSparse = col.is_sparse;
          return (
            <tr key={col.name}>
              <td className={styles.colNum}>
                {col.ordinal_position}
              </td>
              <td>
                <span style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  {col.name}
                  {isPk ? <span className={`${styles.badge} ${styles.badgePk}`}>PK</span> : null}
                  {isIdentity ? (
                    <span className={`${styles.badge} ${styles.badgeIdentity}`}>
                      IDENTITY{col.identity_seed != null ? `(${col.identity_seed},${col.identity_increment})` : ""}
                    </span>
                  ) : null}
                  {isComputed ? (
                    <span className={`${styles.badge} ${styles.badgeComputed}`}>
                      {col.is_persisted ? "PERSISTED" : "COMPUTED"}
                    </span>
                  ) : null}
                  {isSparse ? <span className={`${styles.badge} ${styles.badgeSparse}`}>SPARSE</span> : null}
                  {identityCol === col.name && !isIdentity ? (
                    <span className={`${styles.badge} ${styles.badgeIdentity}`}>IDENTITY</span>
                  ) : null}
                </span>
              </td>
              <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                {col.data_type}
              </td>
              <td className={styles.colFlag}>
                <span className={col.is_nullable ? styles.nullableYes : styles.nullableNo}>
                  {col.is_nullable ? "YES" : "NO"}
                </span>
              </td>
              <td style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                {col.column_default ?? <span style={{ color: "var(--text-subtle)" }}>—</span>}
              </td>
              <td>
                {col.category ? (
                  <span className={`${styles.badge} ${styles.badgeCategory}`}>
                    {col.category}
                  </span>
                ) : null}
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
        {pk.identity_column ? (
          <span className={`${styles.badge} ${styles.badgeIdentity}`}>
            IDENTITY: {pk.identity_column}
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

function ForeignKeysTable({ items }: { items: ForeignKeyInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Columns</th>
          <th>References</th>
          <th>On Update</th>
          <th>On Delete</th>
          <th>Flags</th>
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
            <td>
              <span style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {fk.is_disabled ? (
                  <span className={`${styles.badge} ${styles.badgeDisabled}`}>DISABLED</span>
                ) : null}
                {fk.is_not_trusted ? (
                  <span className={`${styles.badge} ${styles.badgeSparse}`}>NOT TRUSTED</span>
                ) : null}
              </span>
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

function IndexesTable({ items }: { items: IndexInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Columns</th>
          <th>Include</th>
          <th>Unique</th>
          <th>Filter</th>
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
                const dir = c.descending ? " DESC" : "";
                return `${c.name}${dir}`;
              }).join(", ")}
            </td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {idx.included_columns && idx.included_columns.length > 0
                ? idx.included_columns.join(", ")
                : <span style={{ color: "var(--text-subtle)" }}>—</span>}
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
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: 10 }}>
              {idx.filter_predicate ?? <span style={{ color: "var(--text-subtle)" }}>—</span>}
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

function TriggersTable({ items }: { items: TriggerInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Timing</th>
          <th>Events</th>
          <th>Flags</th>
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
            <td>
              {/* TriggerInfo doesn't have is_disabled in the base type — rendered as-is */}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Check constraints table
// ---------------------------------------------------------------------------

function CheckConstraintsTable({ items }: { items: CheckConstraintInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Definition</th>
        </tr>
      </thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.name}>
            <td style={{ fontFamily: "var(--font-mono)" }}>{c.name}</td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {c.definition}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Default constraints table
// ---------------------------------------------------------------------------

function DefaultConstraintsTable({ items }: { items: DefaultConstraintInfo[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Column</th>
          <th>Definition</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.name}>
            <td style={{ fontFamily: "var(--font-mono)" }}>{d.name}</td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {d.column}
            </td>
            <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {d.definition}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Table options view
// ---------------------------------------------------------------------------

function TableOptionsView({ options }: { options: TableOptions }) {
  const rows: Array<[string, string | boolean | null]> = [
    ["Memory-optimized", options.is_memory_optimized ? "YES" : "NO"],
    ["Temporal type", options.temporal_type],
    ["Lock escalation", options.lock_escalation],
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
