import { invoke } from "@tauri-apps/api/core";
import { toAppError, AppError } from "@/platform/errors/AppError";
import type {
  ActiveConnection,
  ConnectResult,
  ParseUrlResult,
  PostgresParams,
  TestResult,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

interface RawTestResult {
  ok: boolean;
  latencyMs?: number;
  serverVersion?: string;
  error?: { kind: string; message: unknown };
}

export const postgresApi = {
  async testConnection(params: PostgresParams, secret?: string | null): Promise<TestResult> {
    const raw = await call<RawTestResult>("postgres_test_connection", {
      params,
      secret: secret ?? null,
    });
    if (raw.ok && typeof raw.latencyMs === "number" && typeof raw.serverVersion === "string") {
      return { ok: true, latencyMs: raw.latencyMs, serverVersion: raw.serverVersion };
    }
    const err = toAppError(raw.error ?? { kind: "Internal", message: "test failed" });
    return { ok: false, error: err };
  },

  connect: (id: string) => call<ConnectResult>("postgres_connect", { id }),
  disconnect: (id: string) => call<void>("postgres_disconnect", { id }),
  disconnectAll: () => call<number>("postgres_disconnect_all"),
  listActive: () => call<ActiveConnection[]>("postgres_list_active"),
  parseUrl: (input: string) => call<ParseUrlResult>("postgres_parse_url", { input }),
};

export { AppError };
