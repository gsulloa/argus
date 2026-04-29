import { type CSSProperties } from "react";
import styles from "./ActivityLogPanel.module.css";
import type { ActivityLogEntry, ActivityKind, Metric } from "./types";

const KIND_LABEL: Record<ActivityKind, string> = {
  test_connection: "test",
  connect: "connect",
  disconnect: "disconnect",
  list_schemas: "schemas",
  list_relations: "relations",
  list_structure: "structure",
  list_table_extras: "table extras",
  query_table: "query",
  count_table: "count",
  apply_edits: "apply",
};

const SUMMARY_TRUNCATE = 120;

export interface ActivityLogRowProps {
  entry: ActivityLogEntry;
  expanded: boolean;
  connectionLabel: string;
  onClick: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  style?: CSSProperties;
}

export function ActivityLogRow({
  entry,
  expanded,
  connectionLabel,
  onClick,
  onKeyDown,
  style,
}: ActivityLogRowProps) {
  return (
    <>
      <div
        className={styles.row}
        data-status={entry.status}
        data-expanded={expanded}
        onClick={onClick}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        style={style}
      >
        <span className={styles.timestamp}>{formatTimestamp(entry.timestamp_unix_ms)}</span>
        <span className={styles.connection}>{connectionLabel}</span>
        <span className={styles.kind}>
          {KIND_LABEL[entry.kind]}
          {entry.origin === "auto" ? " · auto" : ""}
        </span>
        <span className={styles.summary}>
          {summarize(entry.sql, entry.kind)}
        </span>
        <span className={styles.duration}>{entry.duration_ms} ms</span>
        <span className={styles.metric} data-status={entry.status}>
          {renderMetric(entry)}
        </span>
      </div>
      {expanded ? <ActivityLogDetail entry={entry} /> : null}
    </>
  );
}

function ActivityLogDetail({ entry }: { entry: ActivityLogEntry }) {
  return (
    <div className={styles.detail}>
      {entry.sql ? (
        <>
          <div className={styles.detailLabel}>SQL</div>
          <pre className={styles.detailSql}>{entry.sql}</pre>
        </>
      ) : null}
      {entry.params && entry.params.length > 0 ? (
        <>
          <div className={styles.detailLabel}>Parameters</div>
          <ol className={styles.detailParams}>
            {entry.params.map((p, idx) => (
              <li key={idx}>{p}</li>
            ))}
          </ol>
        </>
      ) : null}
      {entry.metric ? (
        <>
          <div className={styles.detailLabel}>Metric</div>
          <div>{renderMetricLong(entry.metric)}</div>
        </>
      ) : null}
      {entry.error ? (
        <>
          <div className={styles.detailLabel}>Error</div>
          <div className={styles.detailError}>
            {entry.error.code ? `[${entry.error.code}] ` : ""}
            {entry.error.message}
          </div>
        </>
      ) : null}
    </div>
  );
}

function summarize(sql: string | null, kind: ActivityKind): string {
  if (!sql) return KIND_LABEL[kind];
  const single = sql.replace(/\s+/g, " ").trim();
  if (single.length <= SUMMARY_TRUNCATE) return single;
  return `${single.slice(0, SUMMARY_TRUNCATE)}…`;
}

function renderMetric(entry: ActivityLogEntry): string {
  if (entry.status === "err") {
    return entry.error?.message ?? "error";
  }
  if (!entry.metric) return "ok";
  return renderMetricShort(entry.metric);
}

function renderMetricShort(metric: Metric): string {
  switch (metric.kind) {
    case "rows":
      return `${formatNumber(metric.value)} ${metric.value === 1 ? "row" : "rows"}`;
    case "count":
      return `${formatNumber(metric.value)}`;
    case "items":
      return `${formatNumber(metric.value)} ${metric.value === 1 ? "item" : "items"}`;
    case "server_version":
      return shortenVersion(metric.value);
  }
}

function renderMetricLong(metric: Metric): string {
  switch (metric.kind) {
    case "rows":
      return `${formatNumber(metric.value)} ${metric.value === 1 ? "row" : "rows"} returned`;
    case "count":
      return `count = ${formatNumber(metric.value)}`;
    case "items":
      return `${formatNumber(metric.value)} ${metric.value === 1 ? "item" : "items"} listed`;
    case "server_version":
      return metric.value;
  }
}

function shortenVersion(v: string): string {
  const m = /PostgreSQL\s+(\d+(?:\.\d+)?)/i.exec(v);
  return m ? `pg ${m[1]}` : v.slice(0, 16);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatTimestamp(unixMs: number): string {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
