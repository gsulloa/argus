/**
 * §20.7 — MS SQL Server export menu.
 * Dropdown with CSV / JSON Lines / XLSX options.
 * Mirrors src/modules/mysql/sql/export/ExportMenu.tsx.
 */

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useToast } from "@/platform/toast";
import type { ColumnInfo } from "../../types";
import type { CellValue } from "../../data/types";
import { toCsv } from "./toCsv";
import { toJsonl } from "./toJsonl";
import { toXlsx } from "./toXlsx";
import { saveExport, type ExportFormat } from "./saveExport";
import styles from "./ExportMenu.module.css";

interface Props {
  connectionName: string;
  columns: ColumnInfo[];
  rows: CellValue[][];
  truncated: boolean;
}

export function ExportMenu({ connectionName, columns, rows, truncated }: Props) {
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
      console.error("[argus.mssql.sql.export]", e);
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
