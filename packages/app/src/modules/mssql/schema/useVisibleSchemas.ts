import { useCallback, useMemo } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import type { SchemaInfo } from "../types";

/**
 * Persisted selection shape for MSSQL visible schemas.
 * Setting key: `mssqlVisibleSchemas:<connectionId>`
 * System schemas hidden by default: sys, INFORMATION_SCHEMA, db_owner, db_accessadmin,
 * db_securityadmin, db_ddladmin, db_backupoperator, db_datareader, db_datawriter,
 * db_denydatareader, db_denydatawriter, guest.
 */
export interface VisibleSchemasSetting {
  /** Schema names the user has explicitly chosen. `null` = default. */
  selected: string[] | null;
  /** Whether system schemas are shown. */
  showSystem: boolean;
}

const DEFAULT: VisibleSchemasSetting = { selected: null, showSystem: false };

function settingsKey(connectionId: string) {
  return `mssqlVisibleSchemas:${connectionId}`;
}

export interface UseVisibleSchemasResult {
  /** Visible schema names, in the order returned by `listSchemas`. */
  visible: Set<string>;
  /** Filtered list of all schemas the picker should display. */
  schemas: SchemaInfo[];
  /** True when system schemas are included in the visible set. */
  showSystem: boolean;
  /** True when the user has not explicitly chosen any selection yet. */
  isDefault: boolean;
  toggleSchema(name: string): void;
  toggleShowSystem(): void;
  selectAll(): void;
  clear(): void;
}

export function useVisibleSchemas(
  connectionId: string,
  schemas: SchemaInfo[],
): UseVisibleSchemasResult {
  const [setting, setSetting] = useSetting<VisibleSchemasSetting>(
    settingsKey(connectionId),
    DEFAULT,
  );

  const showSystem = setting.showSystem;
  const isDefault = setting.selected === null;

  const visible = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const s of schemas) {
      if (!showSystem && s.is_system) continue;
      if (setting.selected === null) {
        out.add(s.name);
      } else if (setting.selected.includes(s.name)) {
        out.add(s.name);
      }
    }
    return out;
  }, [schemas, showSystem, setting.selected]);

  const toggleSchema = useCallback(
    (name: string) => {
      setSetting((prev) => {
        const base = prev.selected ?? schemas.filter((s) => !s.is_system).map((s) => s.name);
        const present = base.includes(name);
        const next = present ? base.filter((n) => n !== name) : [...base, name];
        return { ...prev, selected: next };
      });
    },
    [setSetting, schemas],
  );

  const toggleShowSystem = useCallback(() => {
    setSetting((prev) => ({ ...prev, showSystem: !prev.showSystem }));
  }, [setSetting]);

  const selectAll = useCallback(() => {
    setSetting((prev) => ({
      ...prev,
      selected: schemas
        .filter((s) => prev.showSystem || !s.is_system)
        .map((s) => s.name),
    }));
  }, [setSetting, schemas]);

  const clear = useCallback(() => {
    setSetting((prev) => ({ ...prev, selected: [] }));
  }, [setSetting]);

  return {
    visible,
    schemas,
    showSystem,
    isDefault,
    toggleSchema,
    toggleShowSystem,
    selectAll,
    clear,
  };
}
