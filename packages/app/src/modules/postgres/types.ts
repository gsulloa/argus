import type { AppError } from "@/platform/errors/AppError";

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export const SSL_MODES: SslMode[] = [
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

export interface PostgresParams {
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: SslMode;
  application_name?: string | null;
  read_only: boolean;
}

export type TestResult =
  | { ok: true; latencyMs: number; serverVersion: string }
  | { ok: false; error: AppError };

export interface ActiveConnection {
  id: string;
  server_version: string;
  read_only: boolean;
  connected_at_unix_ms: number;
}

export interface ConnectResult {
  server_version: string;
  read_only: boolean;
}

export interface ParseUrlResult {
  params: PostgresParams;
  password: string | null;
}

export const POSTGRES_KIND = "postgres";
