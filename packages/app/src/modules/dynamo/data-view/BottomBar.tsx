/**
 * BottomBar — status bar for the DynamoDB Data View tab.
 *
 * Shows:
 *   - Items loaded count (Intl.NumberFormat, en-US grouping)
 *   - Count result slot: "Count: <total> (scanned <scanned>)" when present
 *   - Loading / error status
 *
 * The Count result slot is cleared by the parent when builder state changes
 * (mode/index/filter/key-condition).  Phase 8 (task 13.2/13.3) wires the
 * clearing logic; here we just render whatever is passed in.
 */

import { Loader2 } from "lucide-react";
import type { DynamoItemsStatus } from "./useDynamoItems";
import styles from "./BottomBar.module.css";

const fmt = new Intl.NumberFormat("en-US");

export interface CountResult {
  totalCount: number;
  totalScannedCount: number;
}

export interface BottomBarProps {
  /** Number of items currently loaded in the result list. */
  itemsLoaded: number;
  status: DynamoItemsStatus;
  error?: { message: string; code?: string };
  /** Present when the Count button has been fired and returned. */
  countResult?: CountResult;
}

export function BottomBar({ itemsLoaded, status, error, countResult }: BottomBarProps) {
  return (
    <div className={styles.root}>
      <span className={styles.count}>
        {fmt.format(itemsLoaded)} item{itemsLoaded === 1 ? "" : "s"} loaded
      </span>

      {countResult && (
        <>
          <span className={styles.sep}>·</span>
          <span className={styles.countResult}>
            Count: {fmt.format(countResult.totalCount)} (scanned{" "}
            {fmt.format(countResult.totalScannedCount)})
          </span>
        </>
      )}

      <span className={styles.spacer} />

      {status === "loading" && (
        <span className={styles.statusLoading}>
          <Loader2 size={10} className={styles.spinner} />
          Loading…
        </span>
      )}

      {status === "error" && error && (
        <span className={styles.errorText} title={error.message}>
          {error.code ? `[${error.code}] ` : ""}
          {error.message}
        </span>
      )}
    </div>
  );
}
