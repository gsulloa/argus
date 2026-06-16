/**
 * ModelEditor — Radix Dialog modal for creating / editing a DynamoDB entity model.
 *
 * Tasks 4.1 + 4.2
 *
 * Props (controlled):
 *   open / describe / initial / existingNames / onClose / onSave / onDelete / saving
 *
 * Internal state seeded from `initial` when open flips true:
 *   name, accessPatterns, body
 *
 * Per-row preview: calls compileModel with sentinel params ("·") to derive
 * the key preview line beneath each access-pattern row.
 *
 * Design: follows DESIGN.md (Geist, --accent violet, thin borders, compact spacing).
 */

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { compileModel } from "./modelCompiler";
import { validateDraft } from "./validateDraft";
import type { AccessPattern, DynamoModel, ModelDraft } from "./types";
import styles from "./ModelEditor.module.css";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModelEditorProps {
  open: boolean;
  describe: TableDescription | null;
  /** Seed for editing; null/undefined → creating a new model. */
  initial?: DynamoModel | null;
  /** Names of other existing models (for collision hint). */
  existingNames?: string[];
  onClose(): void;
  onSave(draft: ModelDraft, opts: { isEdit: boolean; previousName?: string }): void;
  onDelete?(name: string): void;
  saving?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENTINEL = "·";
const PARAM_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function sentinelParams(pk: string, sk: string | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const tpl of [pk, sk ?? ""]) {
    let m: RegExpExecArray | null;
    const re = new RegExp(PARAM_RE.source, "g");
    while ((m = re.exec(tpl)) !== null) {
      const ident = m[1];
      if (ident) params[ident] = SENTINEL;
    }
  }
  return params;
}

/** Build the <select> option list for the index field. */
interface IndexOption {
  value: string;
  label: string;
}

function buildIndexOptions(describe: TableDescription): IndexOption[] {
  const pk = describe.key_schema.find((k) => k.key_type === "HASH");
  const sk = describe.key_schema.find((k) => k.key_type === "RANGE");
  const primaryLabel = `Primary (PK: ${pk?.attribute_name ?? "?"}${sk ? `, SK: ${sk.attribute_name}` : ""})`;
  const opts: IndexOption[] = [{ value: "table", label: primaryLabel }];

  for (const gsi of describe.global_secondary_indexes) {
    const gpk = gsi.key_schema.find((k) => k.key_type === "HASH");
    const gsk = gsi.key_schema.find((k) => k.key_type === "RANGE");
    opts.push({
      value: gsi.index_name,
      label: `GSI ${gsi.index_name} (PK: ${gpk?.attribute_name ?? "?"}${gsk ? `, SK: ${gsk.attribute_name}` : ""})`,
    });
  }

  for (const lsi of describe.local_secondary_indexes) {
    const lpk = lsi.key_schema.find((k) => k.key_type === "HASH");
    const lsk = lsi.key_schema.find((k) => k.key_type === "RANGE");
    opts.push({
      value: lsi.index_name,
      label: `LSI ${lsi.index_name} (PK: ${lpk?.attribute_name ?? "?"}${lsk ? `, SK: ${lsk.attribute_name}` : ""})`,
    });
  }

  return opts;
}

/** Derive a default initial access pattern. */
function defaultAp(_describe: TableDescription | null): AccessPattern {
  return { index: "table", pk: "", sk: "" };
}

// ---------------------------------------------------------------------------
// AccessPatternRow sub-component
// ---------------------------------------------------------------------------

interface ApRowProps {
  index: number;
  ap: AccessPattern;
  describe: TableDescription | null;
  indexOptions: IndexOption[];
  issues: { reason: string; field?: string }[];
  onRemove(): void;
  onMoveUp(): void;
  onMoveDown(): void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange(next: AccessPattern): void;
}

function AccessPatternRow({
  index,
  ap,
  describe,
  indexOptions,
  issues,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onChange,
}: ApRowProps) {
  // Compute the key preview line using compileModel with sentinel params.
  const preview = (() => {
    if (!describe) return null;
    const params = sentinelParams(ap.pk, ap.sk);
    const result = compileModel(ap, params, describe);
    if (result.kind === "error") {
      return { kind: "error" as const, text: result.reason };
    }
    const pkName = result.query.partitionKey.name;
    const pkVal = result.query.partitionKey.value.type === "S"
      ? result.query.partitionKey.value.value
      : result.query.partitionKey.value.type === "N"
        ? result.query.partitionKey.value.value
        : "?";

    let text = `${pkName} = ${pkVal}`;
    const sk = result.query.sortKey;
    if (sk) {
      const skVal = "value" in sk
        ? (sk.value && "type" in sk.value
            ? (sk.value.type === "S" || sk.value.type === "N" ? sk.value.value : "?")
            : "?")
        : "?";
      text += ` · ${sk.name} ${sk.op} ${skVal}`;
    }
    return { kind: "ok" as const, text };
  })();

  const indexError = issues.find((i) => i.field === "index");
  const pkError = issues.find((i) => i.field === "pk");
  const skError = issues.find((i) => i.field === "sk");
  // General row error (no specific field)
  const generalError = issues.find((i) => !i.field);

  return (
    <div className={styles.apCard}>
      {/* Card header: name + reorder + remove */}
      <div className={styles.apCardHeader}>
        <input
          type="text"
          {...noAutoCorrectProps}
          className={styles.apNameInput}
          value={ap.name ?? ""}
          onChange={(e) => onChange({ ...ap, name: e.target.value || undefined })}
          placeholder="label (optional)"
          aria-label={`Access pattern ${index + 1} label`}
          data-testid={`model-editor-ap-${index}-name`}
        />
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onMoveUp}
          disabled={!canMoveUp}
          aria-label="Move access pattern up"
          title="Move up"
        >
          ▲
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onMoveDown}
          disabled={!canMoveDown}
          aria-label="Move access pattern down"
          title="Move down"
        >
          ▼
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
          onClick={onRemove}
          aria-label="Remove access pattern"
          title="Remove"
        >
          ×
        </button>
      </div>

      {/* Card body: index + pk + sk */}
      <div className={styles.apCardBody}>
        {/* Index */}
        <div className={styles.apRow}>
          <span className={styles.apRowLabel}>Index</span>
          {describe ? (
            <select
              className={`${styles.apSelect} ${indexError ? styles.apSelectError : ""}`}
              value={ap.index}
              onChange={(e) => onChange({ ...ap, index: e.target.value })}
              aria-label={`Access pattern ${index + 1} index`}
              data-testid={`model-editor-ap-${index}-index`}
            >
              {indexOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              {...noAutoCorrectProps}
              className={`${styles.apInput} ${indexError ? styles.apInputError : ""}`}
              value={ap.index}
              onChange={(e) => onChange({ ...ap, index: e.target.value })}
              placeholder="table or index name"
              aria-label={`Access pattern ${index + 1} index`}
              data-testid={`model-editor-ap-${index}-index`}
            />
          )}
        </div>

        {/* PK template */}
        <div className={styles.apRow}>
          <span className={styles.apRowLabel}>PK</span>
          <input
            type="text"
            {...noAutoCorrectProps}
            className={`${styles.apInput} ${(pkError || ap.pk.trim() === "") ? styles.apInputError : ""}`}
            value={ap.pk}
            onChange={(e) => onChange({ ...ap, pk: e.target.value })}
            placeholder="USER#${userId}"
            aria-label={`Access pattern ${index + 1} partition key template`}
            data-testid={`model-editor-ap-${index}-pk`}
          />
        </div>

        {/* SK template */}
        <div className={styles.apRow}>
          <span className={styles.apRowLabel}>SK</span>
          <input
            type="text"
            {...noAutoCorrectProps}
            className={`${styles.apInput} ${skError ? styles.apInputError : ""}`}
            value={ap.sk ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              onChange({ ...ap, sk: val || undefined });
            }}
            placeholder="ORDER#${orderId} (optional)"
            aria-label={`Access pattern ${index + 1} sort key template`}
            data-testid={`model-editor-ap-${index}-sk`}
          />
        </div>

        {/* Key preview */}
        {preview && (
          <div
            className={`${styles.apPreview} ${preview.kind === "error" ? styles.apPreviewError : ""}`}
          >
            {preview.text}
          </div>
        )}

        {/* Row-level error (non-field or general) */}
        {(generalError || (issues.length > 0 && !indexError && !pkError && !skError)) && (
          <div className={styles.apRowError}>
            {(generalError ?? issues[0])?.reason}
          </div>
        )}
        {indexError && (
          <div className={styles.apRowError}>{indexError.reason}</div>
        )}
        {pkError && (
          <div className={styles.apRowError}>{pkError.reason}</div>
        )}
        {skError && (
          <div className={styles.apRowError}>{skError.reason}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelEditor
// ---------------------------------------------------------------------------

export function ModelEditor({
  open,
  describe,
  initial,
  existingNames = [],
  onClose,
  onSave,
  onDelete,
  saving = false,
}: ModelEditorProps) {
  const isEdit = !!initial;

  // Form state
  const [name, setName] = useState("");
  const [accessPatterns, setAccessPatterns] = useState<AccessPattern[]>([]);
  const [body, setBody] = useState("");

  // Delete confirm inline step
  const [deleteStep, setDeleteStep] = useState<"idle" | "confirm">("idle");

  // Seed form state when open flips true
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setName(initial?.name ?? "");
      setAccessPatterns(
        initial?.access_patterns && initial.access_patterns.length > 0
          ? initial.access_patterns.map((ap) => ({ ...ap }))
          : [defaultAp(describe)],
      );
      setBody(initial?.body ?? "");
      setDeleteStep("idle");
    }
    prevOpenRef.current = open;
  });

  // Build live draft
  const draft: ModelDraft = {
    name: name.trim(),
    access_patterns: accessPatterns,
    body,
  };

  const validation = validateDraft(draft, describe);

  // Additional client-side check: pk must be non-empty for each access pattern.
  // validateDraft allows empty-string pk (it's valid grammar), but it's meaningless.
  const emptyPkIndices = accessPatterns
    .map((ap, i) => (ap.pk.trim() === "" ? i : -1))
    .filter((i) => i >= 0);
  const hasPkError = emptyPkIndices.length > 0;

  // Collision hint (not part of validateDraft)
  const nameCollision =
    !isEdit &&
    name.trim() !== "" &&
    existingNames.includes(name.trim());

  const indexOptions = describe ? buildIndexOptions(describe) : [];

  function handleSave() {
    if (!validation.valid || saving) return;
    onSave(draft, { isEdit, previousName: initial?.name });
  }

  function handleDeleteClick() {
    if (deleteStep === "idle") {
      setDeleteStep("confirm");
    }
  }

  function handleDeleteConfirm() {
    if (initial?.name) {
      onDelete?.(initial.name);
    }
    setDeleteStep("idle");
  }

  function handleDeleteCancel() {
    setDeleteStep("idle");
  }

  // Access pattern mutators
  function addAp() {
    setAccessPatterns((prev) => [
      ...prev,
      { index: "table", pk: "", sk: "" },
    ]);
  }

  function removeAp(i: number) {
    setAccessPatterns((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateAp(i: number, next: AccessPattern) {
    setAccessPatterns((prev) => prev.map((ap, idx) => (idx === i ? next : ap)));
  }

  function moveApUp(i: number) {
    if (i === 0) return;
    setAccessPatterns((prev) => {
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
      return next;
    });
  }

  function moveApDown(i: number) {
    setAccessPatterns((prev) => {
      if (i >= prev.length - 1) return prev;
      const next = [...prev];
      [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
      return next;
    });
  }

  // Model-level error (index -1)
  const modelLevelIssue = validation.issues.find((iss) => iss.index === -1);
  const nameErrorText =
    nameCollision
      ? `A model named "${name.trim()}" already exists`
      : (modelLevelIssue?.reason ?? null);

  const saveDisabled = !validation.valid || saving || nameCollision || hasPkError;

  const title = isEdit ? `Edit model — ${initial?.name ?? ""}` : "New model";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          aria-label={title}
          data-testid="model-editor"
          onInteractOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          </div>

          {/* Body */}
          <div className={styles.body}>
            {/* Schema-skipped warning */}
            {validation.schemaChecksSkipped && (
              <div
                className={styles.skippedWarning}
                data-testid="model-editor-skipped-warning"
                role="status"
              >
                Schema checks skipped — table not reachable. Templates were checked for syntax only.
              </div>
            )}

            {/* Entity name */}
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="model-editor-name-input">
                Entity name
              </label>
              <input
                id="model-editor-name-input"
                type="text"
                {...noAutoCorrectProps}
                className={`${styles.input} ${nameErrorText ? styles.inputError : ""}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Order"
                autoFocus
                data-testid="model-editor-name"
                aria-describedby={nameErrorText ? "model-editor-name-error" : undefined}
              />
              {nameErrorText && (
                <div
                  id="model-editor-name-error"
                  className={styles.fieldError}
                  role="alert"
                >
                  {nameErrorText}
                </div>
              )}
            </div>

            {/* Access patterns */}
            <div className={styles.apSection}>
              <div className={styles.apSectionHeader}>
                <span className={styles.apSectionLabel}>Access patterns</span>
              </div>
              {accessPatterns.map((ap, i) => {
                const rowIssues = validation.issues
                  .filter((iss) => iss.index === i)
                  .map((iss) => ({ reason: iss.reason, field: iss.field }));
                return (
                  <AccessPatternRow
                    key={i}
                    index={i}
                    ap={ap}
                    describe={describe}
                    indexOptions={indexOptions}
                    issues={rowIssues}
                    onRemove={() => removeAp(i)}
                    onMoveUp={() => moveApUp(i)}
                    onMoveDown={() => moveApDown(i)}
                    canMoveUp={i > 0}
                    canMoveDown={i < accessPatterns.length - 1}
                    onChange={(next) => updateAp(i, next)}
                  />
                );
              })}
              <button
                type="button"
                className={styles.addApBtn}
                onClick={addAp}
                data-testid="model-editor-add-ap"
              >
                ＋ Add access pattern
              </button>
            </div>

            {/* Notes body (Markdown) */}
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="model-editor-body-input">
                Notes (Markdown)
              </label>
              <textarea
                id="model-editor-body-input"
                {...noAutoCorrectProps}
                className={styles.textarea}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="# Entity Notes&#10;&#10;Optional Markdown documentation…"
                data-testid="model-editor-body"
              />
            </div>
          </div>

          {/* Footer */}
          <div className={styles.footer}>
            {/* Delete zone (left side — only in edit mode) */}
            <div>
              {isEdit && onDelete && (
                deleteStep === "idle" ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={handleDeleteClick}
                    disabled={saving}
                    data-testid="model-editor-delete"
                  >
                    Delete
                  </button>
                ) : (
                  <div className={styles.deleteConfirm}>
                    <span className={styles.deleteConfirmLabel}>Confirm delete?</span>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnDanger}`}
                      onClick={handleDeleteConfirm}
                      disabled={saving}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSecondary}`}
                      onClick={handleDeleteCancel}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                  </div>
                )
              )}
            </div>

            {/* Cancel + Save (right side) */}
            <div className={styles.footerRight}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSecondary}`}
                onClick={onClose}
                disabled={saving}
                data-testid="model-editor-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleSave}
                disabled={saveDisabled}
                title={!validation.valid ? "Fix validation errors before saving" : undefined}
                data-testid="model-editor-save"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
