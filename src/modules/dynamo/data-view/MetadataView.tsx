/**
 * MetadataView — standalone sub-view rendering a DynamoDB TableDescription.
 *
 * Ported from PlaceholderTab.tsx (src/modules/dynamo/tables/PlaceholderTab.tsx)
 * so the placeholder can be retired in Phase 9 without coupling.
 *
 * Does NOT import from PlaceholderTab — self-contained.
 */

import { useCallback, useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import { dynamoTablesApi } from "@/modules/dynamo/tables/api";
import type { GsiInfo, KeySchemaElement, LsiInfo, TableDescription } from "@/modules/dynamo/tables/types";
import styles from "./MetadataView.module.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function keySchemaLine(
  elements: KeySchemaElement[],
  attrDefs: Array<{ attribute_name: string; attribute_type: string }>,
): string {
  return elements
    .map((el) => {
      const def = attrDefs.find((d) => d.attribute_name === el.attribute_name);
      const type = def ? ` (${def.attribute_type})` : "";
      return `${el.attribute_name}${type} · ${el.key_type}`;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      type="button"
      className={styles.copyBtn}
      onClick={handleClick}
      title={copied ? "Copied!" : (label ?? "Copy")}
      aria-label={copied ? "Copied!" : (label ?? "Copy")}
    >
      <Copy size={11} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// GsiCard
// ---------------------------------------------------------------------------

function GsiCard({
  gsi,
  attrDefs,
}: {
  gsi: GsiInfo;
  attrDefs: Array<{ attribute_name: string; attribute_type: string }>;
}) {
  return (
    <div className={styles.indexCard}>
      <div className={styles.indexName}>{gsi.index_name}</div>
      <div className={styles.indexMeta}>
        <span className={styles.indexMetaItem}>
          Keys:{" "}
          <span className={styles.indexMetaValue}>
            {keySchemaLine(gsi.key_schema, attrDefs)}
          </span>
        </span>
        <span className={styles.indexMetaItem}>
          Projection:{" "}
          <span className={styles.indexMetaValue}>{gsi.projection_type}</span>
        </span>
        <span className={styles.indexMetaItem}>
          Status:{" "}
          <span className={styles.indexMetaValue}>{gsi.index_status}</span>
        </span>
        {gsi.provisioned_throughput && (
          <span className={styles.indexMetaItem}>
            Throughput:{" "}
            <span className={styles.indexMetaValue}>
              R{gsi.provisioned_throughput.read_capacity_units} / W
              {gsi.provisioned_throughput.write_capacity_units}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LsiCard
// ---------------------------------------------------------------------------

function LsiCard({
  lsi,
  attrDefs,
}: {
  lsi: LsiInfo;
  attrDefs: Array<{ attribute_name: string; attribute_type: string }>;
}) {
  return (
    <div className={styles.indexCard}>
      <div className={styles.indexName}>{lsi.index_name}</div>
      <div className={styles.indexMeta}>
        <span className={styles.indexMetaItem}>
          Keys:{" "}
          <span className={styles.indexMetaValue}>
            {keySchemaLine(lsi.key_schema, attrDefs)}
          </span>
        </span>
        <span className={styles.indexMetaItem}>
          Projection:{" "}
          <span className={styles.indexMetaValue}>{lsi.projection_type}</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetadataContents — rendered once describe is available
// ---------------------------------------------------------------------------

function MetadataContents({ describe: desc }: { describe: TableDescription }) {
  const billingLabel =
    desc.billing_mode === "PAY_PER_REQUEST" ? "on-demand" : "provisioned";
  const hasStreams =
    desc.stream_specification != null && desc.stream_specification.stream_enabled;
  const gsiCount = desc.global_secondary_indexes.length;
  const lsiCount = desc.local_secondary_indexes.length;

  const statusBadgeClass =
    desc.table_status === "ACTIVE"
      ? `${styles.badge} ${styles.badgeActive}`
      : `${styles.badge} ${styles.badgeWarning}`;

  return (
    <>
      {/* Identity */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Identity</div>
        <div className={styles.metaGrid}>
          <span className={styles.metaLabel}>ARN</span>
          <div className={styles.arnRow}>
            <span className={styles.arnText}>{desc.table_arn}</span>
            <CopyButton text={desc.table_arn} label="Copy ARN" />
          </div>

          <span className={styles.metaLabel}>Status</span>
          <span>
            <span className={statusBadgeClass}>{desc.table_status}</span>
          </span>

          <span className={styles.metaLabel}>Billing mode</span>
          <span className={styles.metaValue}>{billingLabel}</span>

          <span className={styles.metaLabel}>Created</span>
          <span className={styles.metaValue}>{formatDate(desc.creation_date_time)}</span>

          <span className={styles.metaLabel}>Item count</span>
          <span className={styles.metaValue}>{desc.item_count.toLocaleString()}</span>

          <span className={styles.metaLabel}>Table size</span>
          <span className={styles.metaValue}>{humanizeBytes(desc.table_size_bytes)}</span>

          {hasStreams && desc.stream_specification?.stream_view_type && (
            <>
              <span className={styles.metaLabel}>Stream view</span>
              <span className={styles.metaValue}>
                {desc.stream_specification.stream_view_type}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Key schema */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Key Schema</div>
        <table className={styles.keyTable}>
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Type</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {desc.key_schema.map((el) => {
              const def = desc.attribute_definitions.find(
                (d) => d.attribute_name === el.attribute_name,
              );
              return (
                <tr key={el.attribute_name}>
                  <td>{el.attribute_name}</td>
                  <td>{def?.attribute_type ?? "?"}</td>
                  <td>
                    <span
                      className={
                        el.key_type === "HASH" ? styles.keyTypePk : styles.keyTypeRange
                      }
                    >
                      {el.key_type}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Attribute definitions */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Attribute Definitions</div>
        <table className={styles.keyTable}>
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {desc.attribute_definitions.map((def) => (
              <tr key={def.attribute_name}>
                <td>{def.attribute_name}</td>
                <td>{def.attribute_type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Global secondary indexes */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Global Secondary Indexes ({gsiCount})
        </div>
        {gsiCount === 0 ? (
          <div className={styles.emptyIndexList}>No global secondary indexes.</div>
        ) : (
          <div className={styles.indexList}>
            {desc.global_secondary_indexes.map((gsi) => (
              <GsiCard
                key={gsi.index_name}
                gsi={gsi}
                attrDefs={desc.attribute_definitions}
              />
            ))}
          </div>
        )}
      </div>

      {/* Local secondary indexes */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Local Secondary Indexes ({lsiCount})
        </div>
        {lsiCount === 0 ? (
          <div className={styles.emptyIndexList}>No local secondary indexes.</div>
        ) : (
          <div className={styles.indexList}>
            {desc.local_secondary_indexes.map((lsi) => (
              <LsiCard
                key={lsi.index_name}
                lsi={lsi}
                attrDefs={desc.attribute_definitions}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Describe state
// ---------------------------------------------------------------------------

type DescribeState =
  | { status: "loading" }
  | { status: "ready"; value: TableDescription }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// MetadataView — public component
// ---------------------------------------------------------------------------

export interface MetadataViewProps {
  connectionId: string;
  tableName: string;
  /**
   * Initial describe value from the tab payload. Pass null if not yet loaded;
   * the component will fetch it on mount.
   */
  initialDescribe: TableDescription | null;
  /**
   * Controlled: if the parent has already fetched describe (e.g., the tab
   * mount did the fetch), pass it here and it will be used directly. If both
   * `initialDescribe` and `describe` are null, the component fetches on mount.
   *
   * The "Refresh metadata" button always re-fetches from the backend, and
   * after a successful refresh, calls `onDescribeUpdated` so the parent can
   * keep its own state in sync.
   */
  describe?: TableDescription | null;
  onDescribeUpdated?: (next: TableDescription) => void;
}

export function MetadataView({
  connectionId,
  tableName,
  initialDescribe,
  describe: controlledDescribe,
  onDescribeUpdated,
}: MetadataViewProps) {
  const [state, setState] = useState<DescribeState>(() => {
    const initial = controlledDescribe ?? initialDescribe;
    if (initial) return { status: "ready", value: initial };
    return { status: "loading" };
  });

  const doFetch = useCallback(() => {
    setState({ status: "loading" });
    dynamoTablesApi
      .describeTable({ connectionId, tableName, origin: "user" })
      .then((value) => {
        setState({ status: "ready", value });
        onDescribeUpdated?.(value);
      })
      .catch((e: unknown) => {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Describe failed";
        setState({ status: "error", message: msg });
      });
  }, [connectionId, tableName, onDescribeUpdated]);

  // Fetch on mount if no describe available at all.
  const [hasFetched, setHasFetched] = useState(false);
  if (!hasFetched) {
    setHasFetched(true);
    const initial = controlledDescribe ?? initialDescribe;
    if (!initial) {
      // Kick off fetch (safe to call in render body only once via the guard).
      doFetch();
    }
  }

  // If parent pushes a new describe value, adopt it.
  const effectiveDescribe =
    state.status === "ready"
      ? state.value
      : (controlledDescribe ?? null);

  const isLoading = state.status === "loading";

  return (
    <div className={styles.root}>
      {/* Refresh button row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingBottom: 4 }}>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={doFetch}
          disabled={isLoading}
          aria-label="Refresh metadata"
          title="Refresh metadata"
        >
          <RefreshCw size={11} className={isLoading ? styles.spinner : undefined} />
          Refresh metadata
        </button>
      </div>

      {state.status === "loading" && (
        <div className={styles.loadingState}>
          <Loader2 size={13} className={styles.spinner} />
          Loading table metadata…
        </div>
      )}

      {state.status === "error" && (
        <div className={styles.errorState}>
          <span>Failed to load metadata: {state.message}</span>
          <button type="button" className={styles.errorRetryBtn} onClick={doFetch}>
            Retry
          </button>
        </div>
      )}

      {effectiveDescribe && <MetadataContents describe={effectiveDescribe} />}
    </div>
  );
}
