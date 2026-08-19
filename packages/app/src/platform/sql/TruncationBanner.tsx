/**
 * Shared truncation banner (`openspec/changes/configurable-result-row-cap`,
 * tasks 5.3/5.4). Replaces the five per-engine inline-styled copies (each of
 * which hardcoded `rgba(245,158,11,0.1)` and the literal "10,000"). Renders
 * above the result grid whenever a result has `truncated: true`; callers are
 * responsible for not rendering it otherwise (see `sql-result-row-cap` spec,
 * "Shared truncation banner").
 */
import { RowCapMenu } from "./RowCapSelector";
import styles from "./TruncationBanner.module.css";

export type RowCapSource = "setting" | "hard_ceiling" | "engine";

export interface TruncationBannerProps {
  /** The effective cap that was applied, e.g. `50000`. */
  rowCap: number;
  /** Why the cap was that number. */
  rowCapSource: RowCapSource;
  /**
   * Dialect-specific limit clause name, e.g. `"LIMIT"` or
   * `"TOP / OFFSET … FETCH NEXT"`. Pass `null`/omit for engines with no
   * limit clause (DynamoDB PartiQL) to drop the trailing sentence.
   * Only consulted when `rowCapSource === "setting"`.
   */
  clause?: string | null;
  /**
   * Engine-specific reason, used only when `rowCapSource === "engine"`
   * (e.g. CloudWatch's `"CloudWatch Logs Insights returns at most 10,000
   * records per query"`).
   */
  engineReason?: string;
}

function bannerCopy(props: TruncationBannerProps): string {
  const cap = props.rowCap.toLocaleString();
  switch (props.rowCapSource) {
    case "setting": {
      const base = `Showing the first ${cap} rows — the result hit Argus's row limit.`;
      return props.clause ? `${base} Raise the limit or add a ${props.clause} clause.` : base;
    }
    case "hard_ceiling":
      return `Showing the first ${cap} rows — Argus's maximum result size. Narrow the query to see the rest.`;
    case "engine":
      return `Showing the first ${cap} rows — ${props.engineReason ?? ""}.`;
    default:
      return `Showing the first ${cap} rows.`;
  }
}

export function TruncationBanner(props: TruncationBannerProps) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>{bannerCopy(props)}</span>
      {props.rowCapSource === "setting" ? (
        <RowCapMenu
          trigger={
            <button type="button" className={styles.raiseLimit}>
              Raise limit
            </button>
          }
        />
      ) : null}
    </div>
  );
}
