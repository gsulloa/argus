import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toAppError } from "@/platform/errors/AppError";
import { connectionsApi } from "@/platform/connection-registry/api";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { ContextFolderRow } from "@/modules/context/components/ContextFolderRow";
import type { ConnectionUpdate } from "@/platform/connection-registry/types";
import type { Connection } from "@/platform/connection-registry/types";
import { dynamoApi } from "./api";
import { classifyDynamoError, extractSsoCommand } from "./errors";
import { AWS_REGIONS } from "./regions";
import {
  DYNAMO_KIND,
  type DynamoAuth,
  type DynamoParams,
  type ProfileInfo,
  type TestConnectionResult,
} from "./types";
import {
  validateTableMatch,
  type TableMatch,
} from "./tableMatch";
import overlayStyles from "@/platform/shell/Dialog.module.css";
import styles from "./ConnectionForm.module.css";

export type FormMode =
  | { kind: "create" }
  | { kind: "edit"; connection: Connection }
  | { kind: "duplicate"; connection: Connection }
  | { kind: "credentials-only"; connection: Connection };

export interface DynamoConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: FormMode;
  /** Notified once a connection is saved (created or updated). */
  onSaved?: (saved: Connection) => void;
  /** Notified after a successful Save & Connect — passes the newly active id. */
  onConnected?: (id: string) => void;
}

interface FormState {
  name: string;
  auth: DynamoAuth;
  profile: string;
  region: string;
  endpointUrl: string;
  readOnly: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  // Table-name matching (logical-name normalization)
  matchAdvanced: boolean;
  matchPrefix: string;
  matchSuffix: string;
  matchRegex: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    auth: "access_keys",
    profile: "",
    region: "us-east-1",
    endpointUrl: "",
    readOnly: false,
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    matchAdvanced: false,
    matchPrefix: "",
    matchSuffix: "",
    matchRegex: "",
  };
}

function fromConnection(c: Connection, modeKind: FormMode["kind"]): FormState {
  const p = c.params as Partial<DynamoParams> & Record<string, unknown>;
  const tm = (p.table_match ?? undefined) as TableMatch | undefined;
  return {
    name: modeKind === "duplicate" ? `${c.name} (copy)` : c.name,
    auth: (p.auth as DynamoAuth | undefined) ?? "access_keys",
    profile: typeof p.profile === "string" ? p.profile : "",
    region: typeof p.region === "string" ? p.region : "us-east-1",
    endpointUrl: typeof p.endpoint_url === "string" ? p.endpoint_url : "",
    readOnly: Boolean(p.read_only),
    // Credentials are never pre-filled except in credentials-only mode (handled separately)
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    matchAdvanced: Boolean(tm?.regex),
    matchPrefix: tm?.prefix ?? "",
    matchSuffix: tm?.suffix_pattern ?? "",
    matchRegex: tm?.regex ?? "",
  };
}

/** Build a `TableMatch` (or `undefined`) from the form's matching fields. */
function buildTableMatch(form: FormState): TableMatch | undefined {
  if (form.matchAdvanced) {
    const regex = form.matchRegex.trim();
    return regex ? { regex } : undefined;
  }
  const prefix = form.matchPrefix.trim();
  const suffix = form.matchSuffix.trim();
  if (!prefix && !suffix) return undefined;
  const tm: TableMatch = {};
  if (prefix) tm.prefix = prefix;
  if (suffix) tm.suffix_pattern = suffix;
  return tm;
}

type TestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; result: Extract<TestConnectionResult, { ok: true }> }
  | { kind: "err"; result: Extract<TestConnectionResult, { ok: false }> };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "err"; message: string };

function getTitle(mode: FormMode): string {
  switch (mode.kind) {
    case "create":
      return "New DynamoDB connection";
    case "edit":
      return "Edit DynamoDB connection";
    case "duplicate":
      return "Duplicate DynamoDB connection";
    case "credentials-only":
      return "Re-enter credentials";
  }
}

export function DynamoConnectionForm({
  open,
  onOpenChange,
  mode,
  onSaved,
  onConnected,
}: DynamoConnectionFormProps) {
  const { create, update, refresh: refreshConnections } = useConnections();
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [showMatching, setShowMatching] = useState(false);
  const sessionTokenRef = useRef<HTMLInputElement>(null);

  const isCredentialsOnly = mode.kind === "credentials-only";
  const isEdit = mode.kind === "edit";
  const [contextTick, setContextTick] = useState(0);

  // Reset and initialize form when dialog opens
  useEffect(() => {
    if (!open) return;

    setTest({ kind: "idle" });
    setSave({ kind: "idle" });

    if (mode.kind === "create") {
      setForm(emptyForm());
      setShowMatching(false);
      return;
    }

    if (mode.kind === "edit" || mode.kind === "duplicate") {
      const next = fromConnection(mode.connection, mode.kind);
      setForm(next);
      // Auto-expand the matching section when a rule already exists.
      setShowMatching(
        Boolean(next.matchPrefix || next.matchSuffix || next.matchRegex),
      );
      return;
    }

    if (mode.kind === "credentials-only") {
      // Start with base form from connection, then load credentials
      const base = fromConnection(mode.connection, "edit");
      setForm(base);

      // Load existing access_key_id and secret_access_key from keychain
      connectionsApi
        .getSecret(mode.connection.id)
        .then((secretStr) => {
          if (secretStr) {
            try {
              const parsed = JSON.parse(secretStr) as Record<string, unknown>;
              setForm((f) => ({
                ...f,
                accessKeyId:
                  typeof parsed.access_key_id === "string"
                    ? parsed.access_key_id
                    : "",
                secretAccessKey:
                  typeof parsed.secret_access_key === "string"
                    ? parsed.secret_access_key
                    : "",
                sessionToken: "", // Always empty so user can enter a fresh one
              }));
            } catch {
              // ignore parse errors
            }
          }
          // Focus session token after loading
          setTimeout(() => {
            sessionTokenRef.current?.focus();
          }, 50);
        })
        .catch(() => {
          setTimeout(() => {
            sessionTokenRef.current?.focus();
          }, 50);
        });
    }
  }, [open, mode]);

  // Load profiles when auth mode switches to profile
  useEffect(() => {
    if (!open || form.auth !== "profile") return;

    setProfilesLoading(true);
    dynamoApi
      .listAwsProfiles()
      .then((list) => {
        setProfiles(list);
        // If no profile selected yet and list non-empty, pick first
        if (form.profile === "" && list.length > 0) {
          const first = list[0];
          if (first) {
            setForm((f) => ({
              ...f,
              profile: first.name,
              region: first.region ?? f.region,
            }));
          }
        }
      })
      .catch(() => {
        setProfiles([]);
      })
      .finally(() => setProfilesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.auth]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setTest({ kind: "idle" });
  }

  function handleProfileChange(profileName: string) {
    const found = profiles.find((p) => p.name === profileName);
    setForm((f) => ({
      ...f,
      profile: profileName,
      region: found?.region ?? f.region,
    }));
    setTest({ kind: "idle" });
  }

  const tableMatchError = isCredentialsOnly
    ? null
    : validateTableMatch(buildTableMatch(form));

  function isFormValid(): boolean {
    if (isCredentialsOnly) {
      return Boolean(form.accessKeyId.trim() && form.secretAccessKey.trim());
    }
    if (!form.name.trim()) return false;
    if (!form.region) return false;
    if (tableMatchError) return false;
    if (form.auth === "access_keys") {
      return Boolean(form.accessKeyId.trim() && form.secretAccessKey.trim());
    }
    // profile mode
    return Boolean(form.profile);
  }

  async function buildSecret(): Promise<string | undefined> {
    if (form.auth !== "access_keys") return undefined;
    if (!form.accessKeyId.trim() && !form.secretAccessKey.trim() && !form.sessionToken.trim()) {
      return undefined;
    }
    return JSON.stringify({
      access_key_id: form.accessKeyId.trim(),
      secret_access_key: form.secretAccessKey.trim(),
      session_token: form.sessionToken.trim() || undefined,
    });
  }

  async function handleTest() {
    if (!isFormValid()) return;
    setTest({ kind: "loading" });
    try {
      const params: DynamoParams = {
        auth: form.auth,
        region: form.region,
        endpoint_url: form.endpointUrl.trim() || undefined,
        read_only: form.readOnly,
        profile: form.auth === "profile" ? form.profile : undefined,
        table_match: buildTableMatch(form),
      };

      let secret: string | undefined;
      if (form.auth === "access_keys") {
        secret = JSON.stringify({
          access_key_id: form.accessKeyId.trim(),
          secret_access_key: form.secretAccessKey.trim(),
          session_token: form.sessionToken.trim() || undefined,
        });
      }

      const result = await dynamoApi.testConnection(params, secret);
      if (result.ok) {
        setTest({ kind: "ok", result });
      } else {
        setTest({ kind: "err", result: result as Extract<TestConnectionResult, { ok: false }> });
      }
    } catch (e) {
      const err = toAppError(e);
      setTest({
        kind: "err",
        result: { ok: false, error: err },
      });
    }
  }

  async function handleSave(variant: "save" | "save-and-connect") {
    if (!isFormValid()) return;
    setSave({ kind: "saving" });

    try {
      if (isCredentialsOnly && mode.kind === "credentials-only") {
        await dynamoApi.updateCredentials(mode.connection.id, {
          aws_access_key_id: form.accessKeyId.trim(),
          aws_secret_access_key: form.secretAccessKey.trim(),
          aws_session_token: form.sessionToken.trim() || undefined,
        });
        setSave({ kind: "idle" });
        onOpenChange(false);
        return;
      }

      const params: DynamoParams = {
        auth: form.auth,
        region: form.region,
        endpoint_url: form.endpointUrl.trim() || undefined,
        read_only: form.readOnly,
        profile: form.auth === "profile" ? form.profile : undefined,
        table_match: buildTableMatch(form),
      };

      let saved: Connection | null = null;
      if (mode.kind === "create" || mode.kind === "duplicate") {
        const secret = await buildSecret();
        saved = await create({
          name: form.name.trim(),
          kind: DYNAMO_KIND,
          params: params as unknown as Record<string, unknown>,
          ...(secret ? { secret } : {}),
        });
      } else if (mode.kind === "edit") {
        const patch: ConnectionUpdate = {
          name: form.name.trim(),
          params: params as unknown as Record<string, unknown>,
        };
        // §9.5: Only set secret if user actually filled at least one credential field
        if (
          form.auth === "access_keys" &&
          (form.accessKeyId.trim() || form.secretAccessKey.trim() || form.sessionToken.trim())
        ) {
          patch.secret = await buildSecret();
        }
        // profile mode: never set secret
        saved = await update(mode.connection.id, patch);
      }

      if (saved) {
        onSaved?.(saved);
        if (variant === "save-and-connect") {
          await dynamoApi.connect(saved.id);
          onConnected?.(saved.id);
        }
      }

      setSave({ kind: "idle" });
      onOpenChange(false);
    } catch (e) {
      const err = toAppError(e);
      setSave({ kind: "err", message: err.message ?? "Save failed" });
    }
  }

  const selectedProfile = profiles.find((p) => p.name === form.profile);
  const selectedProfileIsSso = selectedProfile?.sso ?? false;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayStyles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>{getTitle(mode)}</Dialog.Title>
          <Dialog.Description className={styles.subtitle}>
            {isCredentialsOnly
              ? "Your session token expired. Re-enter your credentials to resume."
              : "Configure a DynamoDB connection. Test before saving."}
          </Dialog.Description>

          {isCredentialsOnly && (
            <div className={styles.credentialsOnlyBanner}>
              Session token expired — only credential fields are editable.
            </div>
          )}

          {/* Auth mode radio */}
          {!isCredentialsOnly && (
            <div className={styles.authRadioGroup}>
              <label className={styles.authRadioLabel}>
                <input
                  type="radio"
                  name="auth"
                  value="access_keys"
                  checked={form.auth === "access_keys"}
                  onChange={() => setField("auth", "access_keys")}
                />
                Access Keys
              </label>
              <label className={styles.authRadioLabel}>
                <input
                  type="radio"
                  name="auth"
                  value="profile"
                  checked={form.auth === "profile"}
                  onChange={() => setField("auth", "profile")}
                />
                AWS Profile
              </label>
            </div>
          )}

          <div className={styles.grid}>
            {/* Name — hidden in credentials-only mode */}
            {!isCredentialsOnly && (
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <label className={styles.label}>Name</label>
                <input
                  className={styles.input}
                  data-error={!form.name.trim() ? "true" : undefined}
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="My DynamoDB"
                />
                {!form.name.trim() && (
                  <div className={styles.error}>Required</div>
                )}
              </div>
            )}

            {/* Access keys credential fields */}
            {form.auth === "access_keys" && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Access Key ID</label>
                  <input
                    className={styles.input}
                    data-error={
                      form.accessKeyId.trim() === "" && form.auth === "access_keys" && !isEdit
                        ? "true"
                        : undefined
                    }
                    value={form.accessKeyId}
                    onChange={(e) => setField("accessKeyId", e.target.value)}
                    placeholder={isEdit && !isCredentialsOnly ? "leave blank to keep" : "AKIA…"}
                    autoComplete="off"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Secret Access Key</label>
                  <input
                    className={styles.input}
                    type="password"
                    value={form.secretAccessKey}
                    onChange={(e) => setField("secretAccessKey", e.target.value)}
                    placeholder={isEdit && !isCredentialsOnly ? "leave blank to keep" : ""}
                    autoComplete="new-password"
                  />
                </div>

                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <label className={styles.label}>
                    Session Token{" "}
                    <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
                  </label>
                  <input
                    ref={sessionTokenRef}
                    className={styles.input}
                    type="password"
                    value={form.sessionToken}
                    onChange={(e) => setField("sessionToken", e.target.value)}
                    placeholder={isCredentialsOnly ? "Enter new session token" : "Paste if using temporary credentials"}
                    autoComplete="new-password"
                  />
                  <span className={styles.hint}>
                    If you paste a session token, your credentials are time-limited — Argus will
                    re-ask when they expire.
                  </span>
                </div>
              </>
            )}

            {/* Profile mode fields */}
            {form.auth === "profile" && !isCredentialsOnly && (
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <label className={styles.label}>AWS Profile</label>
                <select
                  className={styles.select}
                  value={form.profile}
                  onChange={(e) => handleProfileChange(e.target.value)}
                  disabled={profilesLoading}
                >
                  {profilesLoading ? (
                    <option value="">Loading…</option>
                  ) : profiles.length === 0 ? (
                    <option value="">No profiles found in ~/.aws/</option>
                  ) : (
                    profiles.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                        {p.sso ? " (SSO)" : ""}
                      </option>
                    ))
                  )}
                </select>
                {selectedProfileIsSso && (
                  <span className={styles.ssoHint}>
                    <span className={styles.ssoBadge}>SSO</span>
                    {" "}SSO profile detected — requires{" "}
                    <code>aws sso login --profile {form.profile}</code> to be active in your
                    terminal.
                  </span>
                )}
              </div>
            )}

            {/* Region — always shown, disabled in credentials-only */}
            {!isCredentialsOnly && (
              <div className={styles.field}>
                <label className={styles.label}>Region</label>
                <select
                  className={styles.select}
                  value={form.region}
                  onChange={(e) => setField("region", e.target.value)}
                >
                  {AWS_REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Endpoint URL — optional, hidden in credentials-only */}
            {!isCredentialsOnly && (
              <div className={styles.field}>
                <label className={styles.label}>
                  Endpoint URL{" "}
                  <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
                </label>
                <input
                  className={styles.input}
                  value={form.endpointUrl}
                  onChange={(e) => setField("endpointUrl", e.target.value)}
                  placeholder="http://localhost:8000"
                />
              </div>
            )}

            {/* Read-only toggle — hidden in credentials-only */}
            {!isCredentialsOnly && (
              <label className={`${styles.toggleRow} ${styles.fieldFull}`}>
                <input
                  type="checkbox"
                  checked={form.readOnly}
                  onChange={(e) => setField("readOnly", e.target.checked)}
                />
                <span>Read-only — block all writes from this connection</span>
              </label>
            )}

            {/* Table name matching — optional, collapsed by default */}
            {!isCredentialsOnly && (
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <button
                  type="button"
                  className={styles.disclosureToggle}
                  aria-expanded={showMatching}
                  onClick={() => setShowMatching((s) => !s)}
                >
                  {showMatching ? "▾" : "▸"} Table name matching{" "}
                  <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
                </button>
                {showMatching && (
                  <div className={styles.matchingBody}>
                    <p className={styles.hint} style={{ marginTop: 0 }}>
                      Fold CDK-style live table names (e.g.{" "}
                      <code>MyApp-prod-EventsTable-3M4N…</code>) to a logical name
                      (<code>EventsTable</code>) so one context folder matches
                      every environment. Leave blank to match exactly.
                    </p>
                    <label className={styles.toggleRow}>
                      <input
                        type="checkbox"
                        checked={form.matchAdvanced}
                        onChange={(e) =>
                          setField("matchAdvanced", e.target.checked)
                        }
                      />
                      <span>Advanced (regex)</span>
                    </label>
                    {form.matchAdvanced ? (
                      <div className={styles.field}>
                        <label className={styles.label}>
                          Regex{" "}
                          <span style={{ fontWeight: 400, opacity: 0.7 }}>
                            (must contain a <code>logical</code> group)
                          </span>
                        </label>
                        <input
                          className={styles.input}
                          data-error={tableMatchError ? "true" : undefined}
                          value={form.matchRegex}
                          onChange={(e) => setField("matchRegex", e.target.value)}
                          placeholder="^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                    ) : (
                      <>
                        <div className={styles.field}>
                          <label className={styles.label}>Prefix to strip</label>
                          <input
                            className={styles.input}
                            value={form.matchPrefix}
                            onChange={(e) => setField("matchPrefix", e.target.value)}
                            placeholder="MyApp-prod-"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                        <div className={styles.field}>
                          <label className={styles.label}>
                            Suffix pattern{" "}
                            <span style={{ fontWeight: 400, opacity: 0.7 }}>
                              (regex)
                            </span>
                          </label>
                          <input
                            className={styles.input}
                            data-error={tableMatchError ? "true" : undefined}
                            value={form.matchSuffix}
                            onChange={(e) => setField("matchSuffix", e.target.value)}
                            placeholder="-[A-Z0-9]+$"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                      </>
                    )}
                    {tableMatchError && (
                      <div className={styles.error}>{tableMatchError}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Context folder row — edit mode only */}
            {!isCredentialsOnly && (
              mode.kind === "edit" ? (
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <ContextFolderRow
                    key={contextTick}
                    connectionId={mode.connection.id}
                    contextPath={mode.connection.context_path ?? null}
                    onChanged={() => {
                      setContextTick((t) => t + 1);
                      void refreshConnections();
                    }}
                  />
                </div>
              ) : (
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <p className={styles.hint} style={{ margin: 0 }}>
                    Save this connection first to link a context folder.
                  </p>
                </div>
              )
            )}
          </div>

          {/* Test result row */}
          {test.kind === "ok" && (
            <div className={styles.testRow} data-kind="ok">
              <div className={styles.testRowInner}>
                <span className={styles.testResultLabel}>Connected</span>
                <span className={styles.testResultDetails}>
                  {test.result.accountId} · {test.result.identityArn} ·{" "}
                  <span className={styles.testCode}>{test.result.latencyMs}ms</span>
                </span>
              </div>
            </div>
          )}
          {test.kind === "err" && (
            <div className={styles.testRow} data-kind="err">
              <div className={styles.testRowInner}>
                <span className={styles.testCode}>
                  {test.result.error.aws?.code ?? test.result.error.kind}
                </span>
                <span>{test.result.error.aws?.message ?? test.result.error.message}</span>
                {classifyDynamoError(test.result.error) === "sso_expired" &&
                  extractSsoCommand(test.result.error) && (
                    <button
                      type="button"
                      className={styles.copyButton}
                      onClick={() => {
                        const cmd = extractSsoCommand(test.result.error)!;
                        void navigator.clipboard.writeText(cmd);
                      }}
                    >
                      Copy command
                    </button>
                  )}
              </div>
            </div>
          )}
          {test.kind === "loading" && (
            <div className={styles.testRow}>Testing connection…</div>
          )}

          {save.kind === "err" && (
            <div className={styles.testRow} data-kind="err">
              Save failed: {save.message}
            </div>
          )}

          <div className={styles.footer}>
            {!isCredentialsOnly && (
              <button
                type="button"
                className={styles.button}
                onClick={handleTest}
                disabled={!isFormValid() || test.kind === "loading" || save.kind === "saving"}
              >
                Test
              </button>
            )}
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
                onClick={() => void handleSave("save")}
                disabled={!isFormValid() || save.kind === "saving"}
              >
                Save
              </button>
              {!isCredentialsOnly && (
                <button
                  type="button"
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() => void handleSave("save-and-connect")}
                  disabled={!isFormValid() || save.kind === "saving"}
                >
                  Save & Connect
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
