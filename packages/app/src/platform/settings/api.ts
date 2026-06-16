import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";

export async function getSetting(key: string): Promise<string | null> {
  try {
    const v = await invoke<string | null>("settings_get", { key });
    return v ?? null;
  } catch (e) {
    throw toAppError(e);
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  try {
    await invoke<void>("settings_set", { key, value });
  } catch (e) {
    throw toAppError(e);
  }
}
