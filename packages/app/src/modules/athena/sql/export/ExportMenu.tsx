/**
 * Athena export menu.
 * Dropdown with CSV / JSON Lines / XLSX options.
 * Uses AthenaResultColumnInfo (name + ty) rather than MySQL's ColumnInfo.
 */

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useToast } from "@/platform/toast";
import type { AthenaResultColumnInfo } from "../../types";
import { toCsv } from "./toCsv";
import { toJsonl } from "./toJsonl";
import { toXlsx } from "./toXlsx";
import { saveExport, type ExportFormat } from "./saveExport";
// Reuse the MySQL export menu styles (same visual language)
import styles from "@/modules/mysql/sql/export/ExportMenu.module.css";

interface Props {
  connectionName: string;
  columns: AthenaResultColumnInfo[];
  rows: unknown[][];
  truncated?: boolean;
}

export function ExportMenu({ connectionName, columns, rows, truncated = false }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleExport(format: ExportFormat) {
    if (busy) return;
    setBusy(true);
    try {
      const contents =
        format === "csv"
          ? toCsv(columns, rows)
          : format === "jsonl"
            ? toJsonl(columns, rows)
            : await toXlsx(columns, rows);
      const path = await saveExport({
        format,
        connectionName,
        truncated,
        contents,
      });
      if (path) {
        toast.show(`Exported ${rows.length.toLocaleString()} rows`, "success");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[argus.athena.sql.export]", e);
      toast.show(`Export failed: ${msg}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          disabled={busy}
          title="Export result"
        >
          <Download size={11} />
          <span>Export</span>
          <ChevronDown size={10} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.menu} align="end" sideOffset={4}>
          <DropdownMenu.Item
            className={styles.item}
            onSelect={() => void handleExport("csv")}
          >
            Export as CSV
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={styles.item}
            onSelect={() => void handleExport("xlsx")}
          >
            Export as Excel (.xlsx)
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={styles.item}
            onSelect={() => void handleExport("jsonl")}
          >
            Export as JSONL
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
