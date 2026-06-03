import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AppError, toAppError } from "@/platform/errors/AppError";
import { connectionsApi } from "@/platform/connection-registry/api";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { Connection } from "@/platform/connection-registry/types";
import { ContextFolderRow } from "@/modules/context/components/ContextFolderRow";
import { postgresApi } from "./api";
import {
  POSTGRES_KIND,
  SSL_MODES,
  type PostgresParams,
  type SslMode,
  type TestResult,
} from "./types";
import overlayStyles from "@/platform/shell/Dialog.module.css";
import styles from "./ConnectionForm.module.css";

type Mode = "create" | "edit" | "duplicate";

export interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  /** Existing connection in edit/duplicate modes. */
  initial?: Connection;
  /** Notified once a connection is saved (created or updated). */
  onSaved?: (saved: Connection) => void;
  /** Notified after a successful Save & Connect — passes the newly active id. */
  onConnected?: (id: string) => void;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslmode: SslMode;
  application_name: string;
  read_only: boolean;
}

function emptyForm(): FormState {
  return {
    name: "",
    host: "",
    port: "5432",
    database: "",
    username: "",
    password: "",
    sslmode: "prefer",
    application_name: "",
    read_only: false,
  };
}

function fromConnection(c: Connection, mode: Mode): FormState {
  const p = c.params as Partial<PostgresParams> & Record<string, unknown>;
  return {
    name: mode === "duplicate" ? `${c.name} (copy)` : c.name,
    host: typeof p.host === "string" ? p.host : "",
    port: typeof p.port === "number" ? String(p.port) : "5432",
    database: typeof p.database === "string" ? p.database : "",
    username: typeof p.username === "string" ? p.username : "",
    password: "",
    sslmode: (p.sslmode as SslMode | undefined) ?? "prefer",
    application_name:
      typeof p.application_name === "string" ? p.application_name : "",
    read_only: Boolean(p.read_only),
  };
}

interface ValidationErrors {
  name?: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  application_name?: string;
}

function validate(form: FormState): ValidationErrors {
  const errs: ValidationErrors = {};
  if (!form.name.trim()) errs.name = "Required";
  if (!form.host.trim()) errs.host = "Required";
  const portNum = Number(form.port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    errs.port = "Port must be 1–65535";
  }
  if (!form.database.trim()) errs.database = "Required";
  if (!form.username.trim()) errs.username = "Required";
  if (form.application_name.trim().length > 0 && form.application_name.trim().length === 0) {
    errs.application_name = "Cannot be only whitespace";
  }
  return errs;
}

function toParams(form: FormState): PostgresParams {
  const appName = form.application_name.trim();
  return {
    host: form.host.trim(),
    port: Number(form.port),
    database: form.database.trim(),
    username: form.username.trim(),
    sslmode: form.sslmode,
    application_name: appName.length > 0 ? appName : null,
    read_only: form.read_only,
  };
}

type TestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; latencyMs: number; serverVersion: string }
  | { kind: "err"; error: AppError };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "err"; error: AppError };

export function ConnectionForm({
  open,
  onOpenChange,
  mode,
  initial,
  onSaved,
  onConnected,
}: ConnectionFormProps) {
  const { create, update, refresh: refreshConnections } = useConnections();
  const [view, setView] = useState<"form" | "url">("form");
  const [form, setForm] = useState<FormState>(() =>
    initial ? fromConnection(initial, mode) : emptyForm(),
  );
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [contextTick, setContextTick] = useState(0);

  // Reset state when the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setForm(initial ? fromConnection(initial, mode) : emptyForm());
      setUrlInput("");
      setUrlError(null);
      setTest({ kind: "idle" });
      setSave({ kind: "idle" });
      setRefreshing(false);
      setRefreshError(null);
      setView("form");
    }
  }, [open, initial, mode]);

  const errors = useMemo(() => validate(form), [form]);
  const isValid = Object.keys(errors).length === 0;

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setTest({ kind: "idle" });
  }

  async function handleParse() {
    setUrlError(null);
    try {
      const parsed = await postgresApi.parseUrl(urlInput);
      const p = parsed.params;
      setForm((f) => ({
        ...f,
        host: p.host,
        port: String(p.port),
        database: p.database,
        username: p.username,
        password: parsed.password ?? f.password,
        sslmode: p.sslmode,
        application_name: p.application_name ?? "",
        read_only: p.read_only,
        // Default the connection name to host/database if user hasn't set one.
        name: f.name.trim().length > 0 ? f.name : `${p.host} • ${p.database}`,
      }));
      setView("form");
    } catch (e) {
      setUrlError((e as AppError).message ?? "Could not parse URL");
    }
  }

  async function handleTest() {
    if (!isValid) return;
    setTest({ kind: "loading" });
    try {
      const params = toParams(form);
      const password = form.password.length > 0 ? form.password : await loadExistingSecret();
      const result: TestResult = await postgresApi.testConnection(params, password ?? null);
      if (result.ok) {
        setTest({
          kind: "ok",
          latencyMs: result.latencyMs,
          serverVersion: result.serverVersion,
        });
      } else {
        setTest({ kind: "err", error: result.error });
      }
    } catch (e) {
      setTest({ kind: "err", error: toAppError(e) });
    }
  }

  async function loadExistingSecret(): Promise<string | undefined> {
    if (mode !== "edit" || !initial) return undefined;
    try {
      const s = await connectionsApi.getSecret(initial.id);
      return s ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function handleRefreshSecret() {
    if (!initial?.id || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const value = await connectionsApi.refreshSecret(initial.id);
      setForm((f) => ({ ...f, password: value ?? "" }));
      setTest({ kind: "idle" });
    } catch (e) {
      setRefreshError(toAppError(e).message ?? "Could not refresh from Keychain");
    } finally {
      setRefreshing(false);
    }
  }

  async function persist(): Promise<Connection | null> {
    if (!isValid) return null;
    setSave({ kind: "saving" });
    try {
      const params = toParams(form);
      const trimmedName = form.name.trim();
      let saved: Connection;
      if (mode === "edit" && initial) {
        // Edit: pass secret only if user typed a new password.
        const patch =
          form.password.length > 0
            ? { name: trimmedName, params: params as unknown as Record<string, unknown>, secret: form.password }
            : { name: trimmedName, params: params as unknown as Record<string, unknown> };
        saved = await update(initial.id, patch);
      } else {
        saved = await create({
          name: trimmedName,
          kind: POSTGRES_KIND,
          params: params as unknown as Record<string, unknown>,
          secret: form.password.length > 0 ? form.password : undefined,
        });
      }
      setSave({ kind: "idle" });
      onSaved?.(saved);
      return saved;
    } catch (e) {
      setSave({ kind: "err", error: toAppError(e) });
      return null;
    }
  }

  async function handleSave() {
    const saved = await persist();
    if (saved) onOpenChange(false);
  }

  async function handleSaveAndConnect() {
    const saved = await persist();
    if (!saved) return;
    try {
      await postgresApi.connect(saved.id);
      onConnected?.(saved.id);
      onOpenChange(false);
    } catch (e) {
      setSave({ kind: "err", error: toAppError(e) });
    }
  }

  const title =
    mode === "edit"
      ? "Edit Postgres connection"
      : mode === "duplicate"
        ? "Duplicate Postgres connection"
        : "New Postgres connection";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayStyles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          <Dialog.Description className={styles.subtitle}>
            Fill the form or paste a connection URL. Test before saving.
          </Dialog.Description>

          <div className={styles.tabs} role="tablist">
            <button
              type="button"
              className={styles.tab}
              data-active={view === "form"}
              onClick={() => setView("form")}
            >
              Form
            </button>
            <button
              type="button"
              className={styles.tab}
              data-active={view === "url"}
              onClick={() => setView("url")}
            >
              URL
            </button>
          </div>

          {view === "url" && (
            <div>
              <div className={styles.urlRow}>
                <input
                  className={`${styles.input} ${styles.urlInput}`}
                  placeholder="postgresql://user:pass@host:5432/database?sslmode=require"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                />
                <button
                  type="button"
                  className={`${styles.button} ${styles.primary}`}
                  onClick={handleParse}
                  disabled={urlInput.trim().length === 0}
                >
                  Parse
                </button>
              </div>
              {urlError && <div className={styles.error}>{urlError}</div>}
            </div>
          )}

          {view === "form" && (
            <div className={styles.grid}>
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <label className={styles.label}>Name</label>
                <input
                  className={styles.input}
                  data-error={Boolean(errors.name)}
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                />
                {errors.name && <div className={styles.error}>{errors.name}</div>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Host</label>
                <input
                  className={styles.input}
                  data-error={Boolean(errors.host)}
                  value={form.host}
                  onChange={(e) => setField("host", e.target.value)}
                  placeholder="localhost"
                />
                {errors.host && <div className={styles.error}>{errors.host}</div>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Port</label>
                <input
                  className={styles.input}
                  data-error={Boolean(errors.port)}
                  value={form.port}
                  onChange={(e) => setField("port", e.target.value)}
                  inputMode="numeric"
                />
                {errors.port && <div className={styles.error}>{errors.port}</div>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Database</label>
                <input
                  className={styles.input}
                  data-error={Boolean(errors.database)}
                  value={form.database}
                  onChange={(e) => setField("database", e.target.value)}
                />
                {errors.database && <div className={styles.error}>{errors.database}</div>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Username</label>
                <input
                  className={styles.input}
                  data-error={Boolean(errors.username)}
                  value={form.username}
                  onChange={(e) => setField("username", e.target.value)}
                />
                {errors.username && <div className={styles.error}>{errors.username}</div>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Password</label>
                <div className={styles.passwordRow}>
                  <input
                    className={`${styles.input} ${styles.passwordInput}`}
                    type="password"
                    value={form.password}
                    onChange={(e) => setField("password", e.target.value)}
                    placeholder={
                      mode === "edit"
                        ? "leave blank to keep existing"
                        : ""
                    }
                  />
                  {mode === "edit" && initial?.id && (
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={handleRefreshSecret}
                      disabled={refreshing}
                      title="Re-read from Keychain"
                      aria-label="Re-read from Keychain"
                    >
                      <RefreshIcon spinning={refreshing} />
                    </button>
                  )}
                </div>
                {refreshError && <div className={styles.error}>{refreshError}</div>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>SSL mode</label>
                <select
                  className={styles.select}
                  value={form.sslmode}
                  onChange={(e) => setField("sslmode", e.target.value as SslMode)}
                >
                  {SSL_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Application name</label>
                <input
                  className={styles.input}
                  value={form.application_name}
                  onChange={(e) => setField("application_name", e.target.value)}
                  placeholder="argus"
                />
              </div>

              <label className={`${styles.toggleRow} ${styles.fieldFull}`}>
                <input
                  type="checkbox"
                  checked={form.read_only}
                  onChange={(e) => setField("read_only", e.target.checked)}
                />
                <span>Read-only — block all writes from this connection</span>
              </label>

              {mode === "edit" && initial ? (
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <ContextFolderRow
                    key={contextTick}
                    connectionId={initial.id}
                    contextPath={initial.context_path ?? null}
                    onChanged={() => {
                      setContextTick((t) => t + 1);
                      void refreshConnections();
                    }}
                  />
                </div>
              ) : (
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <p className={styles.subtitle} style={{ margin: 0 }}>
                    Save this connection first to link a context folder.
                  </p>
                </div>
              )}
            </div>
          )}

          {test.kind === "ok" && (
            <div className={styles.testRow} data-kind="ok">
              Connected — {test.serverVersion} <span className={styles.testCode}>({test.latencyMs}ms)</span>
            </div>
          )}
          {test.kind === "err" && (
            <div className={styles.testRow} data-kind="err">
              {test.error.message}
              {test.error.postgres?.code && (
                <span className={styles.testCode}>SQLSTATE {test.error.postgres.code}</span>
              )}
            </div>
          )}
          {test.kind === "loading" && (
            <div className={styles.testRow}>Testing connection…</div>
          )}

          {save.kind === "err" && (
            <div className={styles.testRow} data-kind="err">
              Save failed: {save.error.message}
            </div>
          )}

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.button}
              onClick={handleTest}
              disabled={!isValid || test.kind === "loading"}
            >
              Test
            </button>
            <div className={styles.footerRight}>
              <button
                type="button"
                className={styles.button}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={handleSave}
                disabled={!isValid || save.kind === "saving"}
              >
                Save
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                onClick={handleSaveAndConnect}
                disabled={!isValid || save.kind === "saving"}
              >
                Save & Connect
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      role="img"
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? styles.spinning : undefined}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
