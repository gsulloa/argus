/**
 * InspectorReview — Radix Dialog showing AI-generated model proposals.
 *
 * Follows DESIGN.md: Geist font, --accent violet, thin borders, compact
 * spacing, no decorative gradients, no bubbly radii.
 *
 * Each proposal card shows: name, confidence badge, valid/invalid badge,
 * provenance entries, warnings, and per-card Save / Edit / Discard buttons.
 * AI metadata (confidence/provenance/warnings) is NOT part of the saved draft.
 */

import * as Dialog from "@radix-ui/react-dialog";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { validateDraft } from "./validateDraft";
import type { InspectedModel, ModelDraft } from "./types";
import styles from "./InspectorReview.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface InspectorReviewProps {
  open: boolean;
  describe: TableDescription | null;
  status: "idle" | "running" | "done" | "error";
  statusMessage: string | null;
  proposals: InspectedModel[];
  error: string | null;
  existingNames: string[];
  saving?: boolean;
  onClose(): void;
  onEdit(model: InspectedModel): void;
  onAccept(draft: ModelDraft): Promise<void> | void;
  onDiscard(name: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceClass(confidence: number): string {
  if (confidence >= 0.7) return styles.confidenceHigh ?? "";
  if (confidence >= 0.4) return styles.confidenceMed ?? "";
  return styles.confidenceLow ?? "";
}

function toPercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

// ---------------------------------------------------------------------------
// ProposalCard sub-component
// ---------------------------------------------------------------------------

interface ProposalCardProps {
  model: InspectedModel;
  describe: TableDescription | null;
  saving: boolean;
  onEdit(): void;
  onAccept(): void;
  onDiscard(): void;
}

function ProposalCard({
  model,
  describe,
  saving,
  onEdit,
  onAccept,
  onDiscard,
}: ProposalCardProps) {
  const draft: ModelDraft = {
    name: model.name,
    access_patterns: model.access_patterns,
    body: model.body ?? undefined,
  };

  const validation = validateDraft(draft, describe);
  const isValid = validation.valid;
  const firstIssue = validation.issues[0];

  return (
    <div className={styles.proposalCard} data-testid={`proposal-card-${model.name}`}>
      {/* Card header */}
      <div className={styles.proposalHeader}>
        <span className={styles.proposalName} data-testid={`proposal-name-${model.name}`}>
          {model.name}
        </span>
        <span
          className={`${styles.confidenceBadge} ${confidenceClass(model.confidence)}`}
          title={`Confidence: ${toPercent(model.confidence)}`}
          data-testid={`proposal-confidence-${model.name}`}
        >
          {toPercent(model.confidence)} confidence
        </span>
        <span
          className={`${styles.validBadge} ${isValid ? styles.validBadgeOk : styles.validBadgeError}`}
          data-testid={`proposal-valid-badge-${model.name}`}
        >
          {isValid ? "Valid" : "Invalid"}
        </span>
      </div>

      {/* Card body */}
      <div className={styles.proposalBody}>
        {/* Provenance */}
        {model.provenance.length > 0 && (
          <div className={styles.provenanceList}>
            <div className={styles.provenanceLabel}>Sources</div>
            {model.provenance.map((prov, i) => (
              <div
                key={i}
                className={styles.provenanceItem}
                data-testid={`proposal-provenance-${model.name}-${i}`}
              >
                <span className={styles.provenanceFile}>{prov.file}</span>
                {prov.lines && (
                  <span className={styles.provenanceLines}>:{prov.lines}</span>
                )}
                {prov.reason && (
                  <span className={styles.provenanceReason}> — {prov.reason}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Warnings */}
        {model.warnings.length > 0 && (
          <div className={styles.warningList}>
            <div className={styles.warningLabel}>Warnings</div>
            {model.warnings.map((w, i) => (
              <div key={i} className={styles.warningItem} data-testid={`proposal-warning-${model.name}-${i}`}>
                {w}
              </div>
            ))}
          </div>
        )}

        {/* Validation error (when invalid) */}
        {!isValid && firstIssue && (
          <div
            className={styles.validationError}
            role="alert"
            data-testid={`proposal-validation-error-${model.name}`}
          >
            {firstIssue.reason}
          </div>
        )}
      </div>

      {/* Card footer: per-proposal actions */}
      <div className={styles.proposalFooter}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={onDiscard}
          data-testid={`proposal-discard-${model.name}`}
        >
          Discard
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={onEdit}
          data-testid={`proposal-edit-${model.name}`}
        >
          Edit
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onAccept}
          disabled={!isValid || saving}
          title={!isValid ? "Fix validation errors — click Edit to adjust" : undefined}
          data-testid={`proposal-save-${model.name}`}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InspectorReview
// ---------------------------------------------------------------------------

export function InspectorReview({
  open,
  describe,
  status,
  statusMessage,
  proposals,
  error,
  saving = false,
  onClose,
  onEdit,
  onAccept,
  onDiscard,
}: InspectorReviewProps) {
  const title =
    status === "running"
      ? "Inspecting codebase…"
      : status === "error"
        ? "Inspection failed"
        : proposals.length > 0
          ? `${proposals.length} model proposal${proposals.length === 1 ? "" : "s"}`
          : "Generate models with AI";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          aria-label={title}
          data-testid="inspector-review"
          onInteractOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <button
              type="button"
              className={styles.headerClose}
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div className={styles.body}>
            {/* Running state */}
            {status === "running" && (
              <div className={styles.runningState} data-testid="inspector-running">
                <div className={styles.spinner} aria-label="Loading" role="status" />
                <div className={styles.runningLabel}>
                  {statusMessage ?? "Reading your codebase…"}
                </div>
              </div>
            )}

            {/* Error state */}
            {status === "error" && error && (
              <div
                className={styles.errorBanner}
                role="alert"
                data-testid="inspector-error"
              >
                {error}
              </div>
            )}

            {/* Proposals */}
            {(status === "done" || proposals.length > 0) && proposals.length === 0 && status !== "running" && (
              <div className={styles.emptyState} data-testid="inspector-empty">
                No model proposals were generated.
              </div>
            )}

            {proposals.map((model) => (
              <ProposalCard
                key={model.name}
                model={model}
                describe={describe}
                saving={saving}
                onEdit={() => onEdit(model)}
                onAccept={() => {
                  void onAccept({
                    name: model.name,
                    access_patterns: model.access_patterns,
                    body: model.body ?? undefined,
                  });
                }}
                onDiscard={() => onDiscard(model.name)}
              />
            ))}
          </div>

          {/* Footer */}
          <div className={styles.footer}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={onClose}
              data-testid="inspector-review-close"
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
