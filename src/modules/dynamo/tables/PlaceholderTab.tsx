/**
 * DynamoDB Table Placeholder Tab — Task group 9.
 *
 * Read-only, dense metadata view for a single DynamoDB table.
 * Self-sufficient: if describe is null on mount, fetches it independently
 * (does NOT subscribe to CacheProvider — the cache may be gone).
 *
 * Tab kind:   "dynamo-table-placeholder"
 * Stable id:  `dynamotbl:<connectionId>:<tableName>`
 * Payload:    DynamoTablePlaceholderPayload
 */

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, RefreshCw, Zap } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { dynamoTablesApi } from "./api";
import type { GsiInfo, KeySchemaElement, LsiInfo, TableDescription } from "./types";
import styles from "./PlaceholderTab.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DYNAMO_TABLE_PLACEHOLDER_KIND = "dynamo-table-placeholder";

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface DynamoTablePlaceholderPayload {
  connectionId: string;
  connectionName: string;
  tableName: string;
  describe: TableDescription | null;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isPayload(v: unknown): v is DynamoTablePlaceholderPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.tableName === "string" &&
    (o.describe === null || typeof o.describe === "object")
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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
// CopyButton — small icon button that copies text to clipboard
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
// MetadataView — rendered once describe is available
// ---------------------------------------------------------------------------

function MetadataView({ describe: desc }: { describe: TableDescription }) {
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
      {/* Identity section */}
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

      {/* Items view coming later */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Items</div>
        <div className={styles.comingSoon}>
          Items view coming in V2 #11 — scan and query support will appear here.
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Describe state (local — not backed by CacheProvider)
// ---------------------------------------------------------------------------

type DescribeState =
  | { status: "loading" }
  | { status: "ready"; value: TableDescription }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// PlaceholderTabRoot — the registered tab renderer
// ---------------------------------------------------------------------------

function PlaceholderTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.root}>Invalid tab payload.</div>;
  }
  return <PlaceholderTabContent payload={tab.payload} />;
}

function PlaceholderTabContent({ payload }: { payload: DynamoTablePlaceholderPayload }) {
  const { connectionId, connectionName, tableName } = payload;

  const [state, setState] = useState<DescribeState>(() => {
    if (payload.describe) {
      return { status: "ready", value: payload.describe };
    }
    return { status: "loading" };
  });

  // Fetch on mount if describe was null, or whenever we need to refresh.
  const doFetch = useCallback(() => {
    setState({ status: "loading" });
    dynamoTablesApi
      .describeTable({ connectionId, tableName, origin: "user" })
      .then((value) => {
        setState({ status: "ready", value });
      })
      .catch((e: unknown) => {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Describe failed";
        setState({ status: "error", message: msg });
      });
  }, [connectionId, tableName]);

  // Initial fetch only if describe was not provided.
  useEffect(() => {
    if (payload.describe === null) {
      doFetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isLoading = state.status === "loading";
  const describe = state.status === "ready" ? state.value : null;

  // Header badges — show what we know regardless of describe state
  const billingLabel =
    describe?.billing_mode === "PAY_PER_REQUEST" ? "on-demand" : "provisioned";
  const hasStreams =
    describe?.stream_specification != null &&
    describe.stream_specification.stream_enabled;

  return (
    <div className={styles.root}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.tableName}>{tableName}</h1>

        <div className={styles.headerBadges}>
          {describe && (
            <>
              <span className={styles.badge}>{billingLabel}</span>
              {hasStreams && (
                <span className={styles.badgeStreams}>
                  <Zap size={10} />
                  streams
                </span>
              )}
              {describe.table_status !== "ACTIVE" && (
                <span className={`${styles.badge} ${styles.badgeWarning}`}>
                  {describe.table_status}
                </span>
              )}
            </>
          )}
          <span className={styles.badge} title={`Connection: ${connectionName}`}>
            {connectionName}
          </span>
        </div>

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

      {/* Body */}
      <div className={styles.body}>
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

        {state.status === "ready" && <MetadataView describe={state.value} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side-effect: register this tab kind with TabRegistry at module import time.
// ---------------------------------------------------------------------------

TabRegistry.register(DYNAMO_TABLE_PLACEHOLDER_KIND, PlaceholderTabRoot);
