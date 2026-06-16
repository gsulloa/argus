import { invoke } from "@tauri-apps/api/core";

export type UpdaterLogLevel = "info" | "warn" | "error";

export function logUpdater(
  level: UpdaterLogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  void invoke("log_updater_event", { level, msg, fields }).catch(() => {
    /* swallow — logging itself must never throw */
  });
}
