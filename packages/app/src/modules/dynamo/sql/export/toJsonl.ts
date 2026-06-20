/**
 * JSON Lines export for DynamoDB PartiQL query results.
 * One JSON object per line, keys = column names, values = AttributeValue scalars.
 */

import type { AttributeMap } from "../../data-view/types";
import { attrValueToString } from "./toCsv";

export function toJsonl(columns: string[], rows: AttributeMap[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const obj: Record<string, unknown> = {};
    for (const col of columns) {
      const val = row[col];
      if (val === undefined) {
        obj[col] = null;
      } else if ("L" in val || "M" in val || "SS" in val || "NS" in val || "BS" in val) {
        // Preserve nested structures as parsed JSON values
        obj[col] = val;
      } else {
        obj[col] = attrValueToString(val) || null;
      }
    }
    lines.push(JSON.stringify(obj));
  }
  return lines.join("\n");
}
