import { useCallback, useMemo } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import type { SchemaSummary } from "./types";

/**
 * Persisted selection shape. `null` for the array means "use the default"
 * (all non-system schemas). When the user touches the picker, we store
 * their explicit selection as an array.
 */
export interface VisibleSchemasSetting {
  /** Schema names the user has explicitly chosen. `null` = default. */
  selected: string[] | null;
  /** Whether system schemas (`pg_*`, `information_schema`) are shown. */
  showSystem: boolean;
}

const DEFAULT: VisibleSchemasSetting = { selected: null, showSystem: false };

function settingsKey(connectionId: string) {
  return `pgVisibleSchemas:${connectionId}`;
}

export interface UseVisibleSchemasResult {
  /** Visible schema names, in the order returned by `listSchemas`. */
  visible: Set<string>;
  /** Filtered list of all schemas the picker should display. */
  schemas: SchemaSummary[];
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
  schemas: SchemaSummary[],
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
