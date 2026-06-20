/**
 * Save DynamoDB PartiQL export to disk via Tauri dialog + fs plugins.
 * Mirror of the Athena saveExport.ts.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";

export type ExportFormat = "csv" | "xlsx" | "jsonl";

interface SaveExportArgs {
  format: ExportFormat;
  connectionName: string;
  truncated: boolean;
  /** Text contents for csv/jsonl, binary contents for xlsx. */
  contents: string | Uint8Array;
}

const FILTER: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: "CSV", extensions: ["csv"] },
  xlsx: { name: "Excel Workbook", extensions: ["xlsx"] },
  jsonl: { name: "JSON Lines", extensions: ["jsonl"] },
};

/** Returns the chosen path on success, or null if the user cancelled. */
export async function saveExport({
  format,
  connectionName,
  truncated,
  contents,
}: SaveExportArgs): Promise<string | null> {
  const ext = format;
  const safeName = sanitizeFileNamePart(connectionName);
  const stamp = formatStamp(new Date());
  const truncatedSuffix = truncated ? "_truncated" : "";
  const defaultPath = `${safeName}_partiql_${stamp}${truncatedSuffix}.${ext}`;

  const path = await save({
    defaultPath,
    filters: [FILTER[format]],
  });
  if (!path) return null;

  if (typeof contents === "string") {
    await writeTextFile(path, contents);
  } else {
    await writeFile(path, contents);
  }
  return path;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatStamp(d: Date): string {
  return (
    `${d.getFullYear()}` +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "_" +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

function sanitizeFileNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "argus";
}
