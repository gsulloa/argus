import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

import { aiApi } from "@/modules/ai/api";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";
import { useAiSettings } from "@/modules/ai/store";
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type AiSettingsInput,
  type AiSettingsView,
  type ProviderId,
  type ProviderListEntry,
  type ValidationResult,
} from "@/modules/ai/types";

import styles from "./SettingsPanel.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  default_provider: ProviderId | null;
  claude_cli_model: string | null;
  codex_cli_model: string | null;
  anthropic_api_model: string | null;
  openai_api_model: string | null;
}

function settingsToForm(settings: AiSettingsView, providers: ProviderListEntry[]): FormState {
  function resolveModel(
    configured: string | null,
    providerId: ProviderId,
  ): string | null {
    if (configured) return configured;
    const entry = providers.find((p) => p.id === providerId);
    return entry?.capabilities.default_model ?? null;
  }

  return {
    default_provider: settings.default_provider,
    claude_cli_model: resolveModel(settings.claude_cli_model, "claude-cli"),
    codex_cli_model: resolveModel(settings.codex_cli_model, "codex-cli"),
    anthropic_api_model: resolveModel(settings.anthropic_api_model, "anthropic-api"),
    openai_api_model: resolveModel(settings.openai_api_model, "openai-api"),
  };
}

function formChanged(loaded: FormState | null, current: FormState): boolean {
  if (!loaded) return false;
  return JSON.stringify(loaded) !== JSON.stringify(current);
}

// ---------------------------------------------------------------------------
// Helper: validation badge
// ---------------------------------------------------------------------------

function validationBadge(v: ValidationResult): { label: string; className: string } {
  switch (v.kind) {
    case "Ready":
      return { label: "Ready", className: styles.badgeReady ?? "" };
    case "Missing":
      return { label: "Missing", className: styles.badgeMissing ?? "" };
    case "Misconfigured":
      return { label: "Misconfigured", className: styles.badgeMisconfigured ?? "" };
  }
}

function validationHint(v: ValidationResult): string | null {
  switch (v.kind) {
    case "Ready":
      return null;
    case "Missing":
      return v.hint;
    case "Misconfigured":
      return v.reason;
  }
}

// ---------------------------------------------------------------------------
// CLI install hints
// ---------------------------------------------------------------------------

const CLI_HINTS: Partial<Record<ProviderId, { text: string; url: string }>> = {
  "claude-cli": {
    text: "Install Claude Code:",
    url: "https://www.anthropic.com/claude-code",
  },
  "codex-cli": {
    text: "Install OpenAI Codex CLI:",
    url: "https://github.com/openai/codex",
  },
};

// ---------------------------------------------------------------------------
// Sub-card
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  entry: ProviderListEntry;
  modelValue: string | null;
  onModelChange: (model: string) => void;
  keyPresent: boolean;
}

function ProviderCard({ entry, modelValue, onModelChange, keyPresent }: ProviderCardProps) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { refresh } = useAiSettings();

  const badge = validationBadge(entry.validation);
  const availableModels = entry.capabilities.available_models;
  const effectiveModel =
    modelValue && availableModels.includes(modelValue)
      ? modelValue
      : entry.capabilities.default_model;

  const handleSaveKey = useCallback(async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await aiApi.setApiKey(entry.id, trimmed);
      setKeyInput("");
      await refresh();
    } finally {
      setSaving(false);
    }
  }, [keyInput, entry.id, refresh]);

  const handleClearKey = useCallback(async () => {
    setClearing(true);
    try {
      await aiApi.deleteApiKey(entry.id);
      await refresh();
    } finally {
      setClearing(false);
    }
  }, [entry.id, refresh]);

  const cliHint = CLI_HINTS[entry.id];

  return (
    <div className={styles.providerCard}>
      <div className={styles.cardHeader}>
        <span className={styles.cardName}>{PROVIDER_LABELS[entry.id]}</span>
        <span className={`${styles.badge} ${badge.className}`}>{badge.label}</span>
      </div>

      {/* Model dropdown */}
      {availableModels.length > 0 && (
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor={`model-${entry.id}`}>
            Model
          </label>
          <select
            id={`model-${entry.id}`}
            className={styles.select}
            value={effectiveModel}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* API key section */}
      {entry.capabilities.requires_api_key && (
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor={`apikey-${entry.id}`}>
            {entry.id === "anthropic-api" ? "Anthropic API key" : "OpenAI API key"}
          </label>
          <div className={styles.keyRow}>
            <input
              id={`apikey-${entry.id}`}
              type="password"
              {...noAutoCorrectProps}
              className={styles.input}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste key…"
            />
            <button
              type="button"
              className={styles.btn}
              disabled={saving || keyInput.trim() === ""}
              onClick={() => void handleSaveKey()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={clearing || !keyPresent}
              onClick={() => void handleClearKey()}
            >
              {clearing ? "Clearing…" : "Clear"}
            </button>
          </div>
          <span className={`${styles.keyIndicator} ${keyPresent ? styles.keyPresent : styles.keyAbsent}`}>
            {keyPresent ? "key present" : "no key"}
          </span>
        </div>
      )}

      {/* CLI install hint */}
      {!entry.capabilities.requires_api_key && cliHint && (
        <p className={styles.cliHint}>
          {cliHint.text}{" "}
          <a
            className={styles.cliHintLink}
            href={cliHint.url}
            target="_blank"
            rel="noreferrer"
          >
            {cliHint.url}
          </a>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const { settings, providers, loading, refresh } = useAiSettings();

  // Track loaded form state for dirty comparison
  const loadedFormRef = useRef<FormState | null>(null);
  const [form, setForm] = useState<FormState>({
    default_provider: null,
    claude_cli_model: null,
    codex_cli_model: null,
    anthropic_api_model: null,
    openai_api_model: null,
  });

  // Refresh when opened
  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  // Sync form from loaded settings
  useEffect(() => {
    if (settings && providers.length > 0) {
      const derived = settingsToForm(settings, providers);
      setForm(derived);
      loadedFormRef.current = derived;
    }
  }, [settings, providers]);

  const setDefaultProvider = useCallback((id: ProviderId) => {
    setForm((f) => ({ ...f, default_provider: id }));
  }, []);

  const setModel = useCallback((providerId: ProviderId, model: string) => {
    setForm((f) => {
      switch (providerId) {
        case "claude-cli":
          return { ...f, claude_cli_model: model };
        case "codex-cli":
          return { ...f, codex_cli_model: model };
        case "anthropic-api":
          return { ...f, anthropic_api_model: model };
        case "openai-api":
          return { ...f, openai_api_model: model };
      }
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    const input: AiSettingsInput = {
      default_provider: form.default_provider,
      claude_cli_model: form.claude_cli_model,
      codex_cli_model: form.codex_cli_model,
      anthropic_api_model: form.anthropic_api_model,
      openai_api_model: form.openai_api_model,
      overrides: settings.overrides.map((o) => ({
        connection_id: o.connection_id,
        provider_id: o.provider_id,
        model: o.model,
      })),
    };
    await aiApi.setSettings(input);
    onOpenChange(false);
  }, [form, settings, onOpenChange]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const isDirty = formChanged(loadedFormRef.current, form);
  const showLoading = loading && !settings;

  const selectedProviderEntry = providers.find((p) => p.id === form.default_provider);
  const selectedProviderIsUnready =
    form.default_provider !== null &&
    selectedProviderEntry !== undefined &&
    selectedProviderEntry.validation.kind !== "Ready";

  function getModelForProvider(id: ProviderId): string | null {
    switch (id) {
      case "claude-cli":
        return form.claude_cli_model;
      case "codex-cli":
        return form.codex_cli_model;
      case "anthropic-api":
        return form.anthropic_api_model;
      case "openai-api":
        return form.openai_api_model;
    }
  }

  function getKeyPresent(id: ProviderId): boolean {
    if (!settings) return false;
    switch (id) {
      case "anthropic-api":
        return settings.key_present.anthropic;
      case "openai-api":
        return settings.key_present.openai;
      default:
        return false;
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>AI Provider Settings</Dialog.Title>

          {showLoading ? (
            <div className={styles.loadingRow}>
              <span className={styles.spinner} aria-hidden="true" />
              <span className={styles.loadingText}>Loading…</span>
            </div>
          ) : (
            <div className={styles.body}>
              {/* --- Default provider radio group --- */}
              <section className={styles.section}>
                <h3 className={styles.sectionLabel}>Default provider</h3>
                <div className={styles.radioGroup} role="radiogroup" aria-label="Default provider">
                  {PROVIDER_IDS.map((id) => {
                    const entry = providers.find((p) => p.id === id);
                    const validation = entry?.validation ?? { kind: "Missing" as const, hint: "Not available" };
                    const badge = validationBadge(validation);
                    const hint = validationHint(validation);
                    const checked = form.default_provider === id;

                    return (
                      <div key={id} className={styles.radioRow}>
                        <label className={styles.radioLabel}>
                          <input
                            type="radio"
                            name="default_provider"
                            value={id}
                            checked={checked}
                            onChange={() => setDefaultProvider(id)}
                            className={styles.radioInput}
                          />
                          <span className={styles.radioText}>{PROVIDER_LABELS[id]}</span>
                          <span className={`${styles.badge} ${badge.className}`}>
                            {badge.label}
                          </span>
                        </label>
                        {hint && (
                          <p className={styles.radioHint}>{hint}</p>
                        )}
                        {checked && selectedProviderIsUnready && (
                          <p className={styles.unreadyWarning}>
                            This provider isn&apos;t ready. Generation will fail until it&apos;s configured.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* --- Per-provider sub-cards --- */}
              <section className={styles.section}>
                <h3 className={styles.sectionLabel}>Provider configuration</h3>
                <div className={styles.cardList}>
                  {PROVIDER_IDS.map((id) => {
                    const entry = providers.find((p) => p.id === id);
                    if (!entry) return null;
                    return (
                      <ProviderCard
                        key={id}
                        entry={entry}
                        modelValue={getModelForProvider(id)}
                        onModelChange={(model) => setModel(id, model)}
                        keyPresent={getKeyPresent(id)}
                      />
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {/* --- Footer --- */}
          <div className={styles.footer}>
            <button
              type="button"
              className={styles.btn}
              onClick={handleCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!isDirty}
              onClick={() => void handleSave()}
              data-testid="settings-save"
            >
              Save settings
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
