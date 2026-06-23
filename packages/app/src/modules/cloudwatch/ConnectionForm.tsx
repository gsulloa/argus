import { useEffect, useRef, useState } from "react";
import { toAppError } from "@/platform/errors/AppError";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { ContextFolderRow } from "@/modules/context/components/ContextFolderRow";
import type { ConnectionUpdate } from "@/platform/connection-registry/types";
import type { Connection } from "@/platform/connection-registry/types";
import { FormWindowSurface } from "@/platform/shell/FormWindowSurface";
import { ColorPicker } from "@/platform/connection-registry/ColorPicker";
import { cloudwatchApi } from "./api";
import { AWS_REGIONS } from "@/modules/dynamo/regions";
import {
  CLOUDWATCH_KIND,
  type CloudwatchAuth,
  type CloudwatchParams,
  type ProfileInfo,
  type TestConnectionResult,
} from "./types";
import { noAutoCorrectProps } from "../shared/text-input-hygiene";
import styles from "@/modules/dynamo/ConnectionForm.module.css";

export type FormMode =
  | { kind: "create" }
  | { kind: "edit"; connection: Connection }
  | { kind: "duplicate"; connection: Connection };

export interface CloudwatchConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: FormMode;
  onSaved?: (saved: Connection) => void;
  onConnected?: (id: string) => void;
}

interface FormState {
  name: string;
  auth: CloudwatchAuth;
  profile: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  color: string | null;
}

function emptyForm(): FormState {
  return {
    name: "",
    auth: "access_keys",
    profile: "",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    color: null,
  };
}

function fromConnection(c: Connection, modeKind: FormMode["kind"]): FormState {
  const p = c.params as Partial<CloudwatchParams> & Record<string, unknown>;
  return {
    name: modeKind === "duplicate" ? `${c.name} (copy)` : c.name,
    auth: (p.auth as CloudwatchAuth | undefined) ?? "access_keys",
    profile: typeof p.profile === "string" ? p.profile : "",
    region: typeof p.region === "string" ? p.region : "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    color: c.color ?? null,
  };
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
      return "New Amazon CloudWatch Logs connection";
    case "edit":
      return "Edit Amazon CloudWatch Logs connection";
    case "duplicate":
      return "Duplicate Amazon CloudWatch Logs connection";
  }
}

export function CloudwatchConnectionForm({
  open,
  onOpenChange,
  mode,
  onSaved,
  onConnected,
}: CloudwatchConnectionFormProps) {
  const { items, create, update, refresh: refreshConnections } = useConnections();
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const isEdit = mode.kind === "edit";
  const sessionTokenRef = useRef<HTMLInputElement>(null);

  // Reset and initialize form when dialog opens
  useEffect(() => {
    if (!open) return;

    setTest({ kind: "idle" });
    setSave({ kind: "idle" });

    if (mode.kind === "create") {
      setForm(emptyForm());
      return;
    }

    if (mode.kind === "edit" || mode.kind === "duplicate") {
      setForm(fromConnection(mode.connection, mode.kind));
    }
  }, [open, mode]);

  // Load profiles when auth mode switches to profile
  useEffect(() => {
    if (!open || form.auth !== "profile") return;

    setProfilesLoading(true);
    cloudwatchApi
      .listAwsProfiles()
      .then((list) => {
        setProfiles(list);
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

  function isFormValid(): boolean {
    if (!form.name.trim()) return false;
    if (!form.region) return false;
    if (form.auth === "access_keys") {
      return Boolean(form.accessKeyId.trim() && form.secretAccessKey.trim());
    }
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

  function buildParams(): CloudwatchParams {
    return {
      auth: form.auth,
      region: form.region,
      profile: form.auth === "profile" ? form.profile : undefined,
    };
  }

  async function handleTest() {
    if (!isFormValid()) return;
    setTest({ kind: "loading" });
    try {
      const params = buildParams();

      let secret: string | undefined;
      if (form.auth === "access_keys") {
        secret = JSON.stringify({
          access_key_id: form.accessKeyId.trim(),
          secret_access_key: form.secretAccessKey.trim(),
          session_token: form.sessionToken.trim() || undefined,
        });
      }

      const result = await cloudwatchApi.testConnection(params, secret);
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
      const params = buildParams();

      let saved: Connection | null = null;
      if (mode.kind === "create" || mode.kind === "duplicate") {
        const secret = await buildSecret();
        saved = await create({
          name: form.name.trim(),
          kind: CLOUDWATCH_KIND,
          params: params as unknown as Record<string, unknown>,
          ...(secret ? { secret } : {}),
          color: form.color,
        });
      } else if (mode.kind === "edit") {
        const patch: ConnectionUpdate = {
          name: form.name.trim(),
          params: params as unknown as Record<string, unknown>,
          color: form.color,
        };
        if (
          form.auth === "access_keys" &&
          (form.accessKeyId.trim() || form.secretAccessKey.trim() || form.sessionToken.trim())
        ) {
          patch.secret = await buildSecret();
        }
        saved = await update(mode.connection.id, patch);
      }

      if (saved) {
        onSaved?.(saved);
        if (variant === "save-and-connect") {
          await cloudwatchApi.connect(saved.id);
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

  if (!open) return null;

  return (
    <FormWindowSurface title={getTitle(mode)} description="Configure an Amazon CloudWatch Logs connection. CloudWatch Logs is read-only. Test before saving.">
          {/* Auth mode radio */}
          <div className={styles.authRadioGroup}>
            <label className={styles.authRadioLabel}>
              <input
                type="radio"
                name="cloudwatch-auth"
                value="access_keys"
                checked={form.auth === "access_keys"}
                onChange={() => setField("auth", "access_keys")}
              />
              Access Keys
            </label>
            <label className={styles.authRadioLabel}>
              <input
                type="radio"
                name="cloudwatch-auth"
                value="profile"
                checked={form.auth === "profile"}
                onChange={() => setField("auth", "profile")}
              />
              AWS Profile
            </label>
          </div>

          <div className={styles.grid}>
            {/* Name */}
            <div className={`${styles.field} ${styles.fieldFull}`}>
              <label className={styles.label}>Name</label>
              <input
                {...noAutoCorrectProps}
                className={styles.input}
                data-error={!form.name.trim() ? "true" : undefined}
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="My CloudWatch"
              />
              {!form.name.trim() && (
                <div className={styles.error}>Required</div>
              )}
            </div>

            {/* Color */}
            <div className={`${styles.field} ${styles.fieldFull}`}>
              <ColorPicker
                label="Color"
                value={form.color}
                onChange={(next) => setField("color", next)}
              />
            </div>

            {/* Access keys credential fields */}
            {form.auth === "access_keys" && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Access Key ID</label>
                  <input
                    {...noAutoCorrectProps}
                    className={styles.input}
                    data-error={
                      form.accessKeyId.trim() === "" && form.auth === "access_keys" && !isEdit
                        ? "true"
                        : undefined
                    }
                    value={form.accessKeyId}
                    onChange={(e) => setField("accessKeyId", e.target.value)}
                    placeholder={isEdit ? "leave blank to keep" : "AKIA…"}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Secret Access Key</label>
                  <input
                    {...noAutoCorrectProps}
                    className={styles.input}
                    type="password"
                    value={form.secretAccessKey}
                    onChange={(e) => setField("secretAccessKey", e.target.value)}
                    placeholder={isEdit ? "leave blank to keep" : ""}
                  />
                </div>

                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <label className={styles.label}>
                    Session Token{" "}
                    <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
                  </label>
                  <input
                    {...noAutoCorrectProps}
                    ref={sessionTokenRef}
                    className={styles.input}
                    type="password"
                    value={form.sessionToken}
                    onChange={(e) => setField("sessionToken", e.target.value)}
                    placeholder="Paste if using temporary credentials"
                  />
                  <span className={styles.hint}>
                    If you paste a session token, your credentials are time-limited.
                  </span>
                </div>
              </>
            )}

            {/* Profile mode fields */}
            {form.auth === "profile" && (
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

            {/* Region */}
            <div className={`${styles.field} ${styles.fieldFull}`}>
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

            {/* Context folder row — edit mode only */}
            {mode.kind === "edit" ? (
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <ContextFolderRow
                  connectionId={mode.connection.id}
                  contextPath={(items.find((c) => c.id === mode.connection.id) ?? mode.connection).context_path ?? null}
                  onChanged={() => { void refreshConnections(); }}
                />
              </div>
            ) : (
              <div className={`${styles.field} ${styles.fieldFull}`}>
                <p className={styles.hint} style={{ margin: 0 }}>
                  Save this connection first to link a context folder.
                </p>
              </div>
            )}
          </div>

          {/* Test result row */}
          {test.kind === "ok" && (
            <div className={styles.testRow} data-kind="ok">
              <div className={styles.testRowInner}>
                <span className={styles.testResultLabel}>Connected</span>
                <span className={styles.testResultDetails}>
                  {test.result.accountId} · {test.result.region} ·{" "}
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
            <button
              type="button"
              className={styles.button}
              onClick={() => void handleTest()}
              disabled={!isFormValid() || test.kind === "loading" || save.kind === "saving"}
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
                onClick={() => void handleSave("save")}
                disabled={!isFormValid() || save.kind === "saving"}
              >
                Save
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                onClick={() => void handleSave("save-and-connect")}
                disabled={!isFormValid() || save.kind === "saving"}
              >
                Save &amp; Connect
              </button>
            </div>
          </div>
    </FormWindowSurface>
  );
}
