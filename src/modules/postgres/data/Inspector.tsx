import { isCellEnvelope, type CellEnvelope, type CellValue, type DataColumn } from "./types";
import { categorize, isMonoCategory } from "./typeHelpers";
import styles from "./Inspector.module.css";

interface Props {
  columns: DataColumn[];
  row: CellValue[] | null;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatScalar(value: CellValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // unreachable for envelopes (handled separately) — fallback to JSON.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function EnvelopeField({ envelope }: { envelope: CellEnvelope }) {
  const label = envelope.kind === "binary" ? "binary" : "truncated";
  return (
    <div>
      <span className={styles.envelopeChip}>
        {label} ~{humanBytes(envelope.byte_length)}
      </span>
      <div className={styles.envelopePreview}>{envelope.preview}</div>
    </div>
  );
}

export function Inspector({ columns, row }: Props) {
  if (!row) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>Inspector</div>
        <div className={styles.empty}>Select a row to inspect.</div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.header}>Inspector</div>
      <div className={styles.body}>
        {columns.map((col, i) => {
          const value = row[i];
          const cat = categorize(col.data_type);
          const isEnvelope = isCellEnvelope(value);
          return (
            <div key={col.name} className={styles.field}>
              <div className={styles.label}>
                <span>{col.name}</span>
                <span className={styles.type}>{col.data_type}</span>
              </div>
              {isEnvelope ? (
                <EnvelopeField envelope={value as CellEnvelope} />
              ) : value === null || value === undefined ? (
                <span className={styles.null}>NULL</span>
              ) : (
                <div
                  className={`${styles.value} ${
                    isMonoCategory(cat) || cat === "json" || cat === "uuid"
                      ? styles.valueMono
                      : ""
                  }`}
                >
                  {formatScalar(value)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
