/**
 * FeedbackDialog — in-app feedback form.
 *
 * Rendered in a dedicated native Tauri window (the `feedback` window).
 * Uses FormWindowSurface as its outer shell instead of Radix Dialog.
 *
 * Tauri command contract:
 *   invoke("submit_feedback", {
 *     message: string,
 *     category?: "bug" | "idea" | "other",
 *     email?: string,
 *     engine?: string | null,
 *     attachmentPaths: string[],
 *   })
 *   → { id: string }    (success)
 *   throws string       (failure)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, CheckCircle, Paperclip, X } from "lucide-react";
import { useToast } from "@/platform/toast";
import { FormWindowSurface } from "@/platform/shell/FormWindowSurface";
import { noAutoCorrectProps } from "@/modules/shared/text-input-hygiene";
import styles from "./FeedbackDialog.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTACHMENTS = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

type Category = "bug" | "idea" | "other";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttachmentFile {
  path: string;
  name: string;
  sizeBytes: number;
}

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active connection engine type (e.g. "postgres", "dynamo"), or null. */
  engine: string | null;
  /**
   * Called when feedback is successfully submitted, before onOpenChange(false).
   * Use this to emit cross-window events or trigger toasts.
   */
  onSubmitted?: () => void;
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

function isValidEmail(v: string): boolean {
  // Lightweight RFC-ish check — good enough for a feedback form.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// ---------------------------------------------------------------------------
// File size formatter
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// FeedbackDialog
// ---------------------------------------------------------------------------

export function FeedbackDialog({ open, onOpenChange, engine, onSubmitted }: FeedbackDialogProps) {
  // Form fields
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [email, setEmail] = useState("");
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Track whether the user has tried to submit (for showing field-level errors)
  const [triedSubmit, setTriedSubmit] = useState(false);

  const toast = useToast();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Focus message field when dialog opens
  useEffect(() => {
    if (open && !succeeded) {
      // Small timeout to let the window finish rendering before stealing focus
      const t = window.setTimeout(() => {
        messageRef.current?.focus();
      }, 80);
      return () => window.clearTimeout(t);
    }
  }, [open, succeeded]);

  // Reset success state when dialog is reopened
  useEffect(() => {
    if (open) {
      setSucceeded(false);
      setSubmitError(null);
      setTriedSubmit(false);
      setAttachmentError(null);
    }
  }, [open]);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const messageTrimmed = message.trim();
  const emailTrimmed = email.trim();
  const messageEmpty = messageTrimmed.length === 0;
  const emailInvalid = emailTrimmed.length > 0 && !isValidEmail(emailTrimmed);

  const canSubmit = !messageEmpty && !emailInvalid && !submitting;

  // ---------------------------------------------------------------------------
  // Attachment picker
  // ---------------------------------------------------------------------------

  const handlePickAttachments = useCallback(async () => {
    setAttachmentError(null);
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      setAttachmentError(`Maximum ${MAX_ATTACHMENTS} files allowed.`);
      return;
    }

    const picked = await dialogOpen({
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"],
        },
      ],
      title: "Attach screenshots (images only)",
    });

    if (!picked) return;

    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;

    const errors: string[] = [];
    const accepted: AttachmentFile[] = [];

    for (const p of paths) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        errors.push(`Only ${MAX_ATTACHMENTS} attachments allowed; skipped extra files.`);
        break;
      }
      const name = p.split(/[\\/]/).pop() ?? p;
      let sizeBytes = 0;
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const assetUrl = convertFileSrc(p);
        const resp = await fetch(assetUrl);
        const blob = await resp.blob();
        sizeBytes = blob.size;
      } catch {
        // If we can't determine size, accept and let Rust validate.
      }

      if (sizeBytes > MAX_FILE_BYTES) {
        errors.push(`"${name}" is ${formatBytes(sizeBytes)} — max is ${formatBytes(MAX_FILE_BYTES)}.`);
        continue;
      }

      accepted.push({ path: p, name, sizeBytes });
    }

    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
    if (errors.length > 0) {
      setAttachmentError(errors.join(" "));
    }
  }, [attachments]);

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
    setAttachmentError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    setTriedSubmit(true);
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await invoke<{ id: string }>("submit_feedback", {
        message: messageTrimmed,
        category: category !== "" ? category : undefined,
        email: emailTrimmed.length > 0 ? emailTrimmed : undefined,
        engine: engine ?? null,
        attachmentPaths: attachments.map((a) => a.path),
      });

      setSucceeded(true);
      // Notify parent of success (e.g. emit cross-window event)
      onSubmitted?.();
      // Auto-close after a moment
      window.setTimeout(() => {
        onOpenChange(false);
        // Reset form after close
        window.setTimeout(() => {
          setMessage("");
          setCategory("");
          setEmail("");
          setAttachments([]);
          setSucceeded(false);
          setSubmitError(null);
          setTriedSubmit(false);
        }, 200);
      }, 2000);
    } catch (err: unknown) {
      // On failure: surface error and PRESERVE all draft content so user can retry.
      const msg =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Submission failed. Please try again.";
      setSubmitError(msg);
      toast.show("Feedback submission failed — draft preserved", "error");
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    messageTrimmed,
    category,
    emailTrimmed,
    engine,
    attachments,
    onOpenChange,
    onSubmitted,
    toast,
  ]);

  // ---------------------------------------------------------------------------
  // Render — success state
  // ---------------------------------------------------------------------------

  const renderSuccess = () => (
    <div className={styles.successBanner}>
      <CheckCircle size={28} className={styles.successIcon} />
      <p className={styles.successTitle}>Feedback sent!</p>
      <p className={styles.successSub}>Thank you — the maintainer will review it shortly.</p>
    </div>
  );

  // ---------------------------------------------------------------------------
  // Render — form state
  // ---------------------------------------------------------------------------

  const renderForm = () => (
    <>
      <div className={styles.body}>
        {/* Submission error banner */}
        {submitError && (
          <div className={styles.errorBanner} role="alert">
            <AlertTriangle size={13} className={styles.errorBannerIcon} />
            <span>{submitError}</span>
          </div>
        )}

        {/* Message */}
        <div className={styles.fieldRow}>
          <div className={styles.fieldLabelRow}>
            <label className={styles.fieldLabel} htmlFor="fb-message">
              Message
            </label>
            <span className={styles.fieldRequired}>required</span>
          </div>
          <textarea
            id="fb-message"
            ref={messageRef}
            className={`${styles.textarea}${triedSubmit && messageEmpty ? ` ${styles.fieldError}` : ""}`}
            {...noAutoCorrectProps}
            spellCheck
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe the issue or idea…"
            rows={5}
          />
          {triedSubmit && messageEmpty && (
            <p className={styles.fieldErrorMsg} role="alert">
              Message is required.
            </p>
          )}
        </div>

        {/* Category */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="fb-category">
            Category
          </label>
          <select
            id="fb-category"
            className={styles.select}
            value={category}
            onChange={(e) => setCategory(e.target.value as Category | "")}
          >
            <option value="">— optional —</option>
            <option value="bug">Bug</option>
            <option value="idea">Idea / feature request</option>
            <option value="other">Other</option>
          </select>
        </div>

        {/* Reply email */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="fb-email">
            Reply email
          </label>
          <input
            id="fb-email"
            type="email"
            className={`${styles.input}${emailInvalid ? ` ${styles.fieldError}` : ""}`}
            {...noAutoCorrectProps}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="optional — for follow-up only"
          />
          {emailInvalid && (
            <p className={styles.fieldErrorMsg} role="alert">
              Enter a valid email address.
            </p>
          )}
        </div>

        {/* Attachments */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>
            Attachments
          </label>

          {/* Privacy notice — always visible */}
          <div className={styles.privacyNotice} role="note">
            <AlertTriangle size={12} className={styles.privacyIcon} />
            <span>
              Before attaching, verify the image contains no sensitive on-screen data
              (connection strings, credentials, query results, or personal information).
            </span>
          </div>

          {/* Picked files */}
          {attachments.length > 0 && (
            <ul className={styles.attachmentList} aria-label="Staged attachments">
              {attachments.map((a) => (
                <li key={a.path} className={styles.attachmentItem}>
                  <Paperclip size={11} aria-hidden="true" />
                  <span className={styles.attachmentName} title={a.name}>{a.name}</span>
                  {a.sizeBytes > 0 && (
                    <span className={styles.attachmentSize}>{formatBytes(a.sizeBytes)}</span>
                  )}
                  <button
                    type="button"
                    className={styles.attachmentRemove}
                    onClick={() => handleRemoveAttachment(a.path)}
                    aria-label={`Remove ${a.name}`}
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Attach button + cap indicator */}
          {attachments.length < MAX_ATTACHMENTS && (
            <button
              type="button"
              className={styles.btn}
              onClick={() => void handlePickAttachments()}
              disabled={submitting}
            >
              <Paperclip size={12} />
              {attachments.length === 0 ? "Attach image…" : "Add another…"}
            </button>
          )}

          <p className={styles.attachmentCap}>
            Up to {MAX_ATTACHMENTS} images, {formatBytes(MAX_FILE_BYTES)} each.
          </p>

          {attachmentError && (
            <p className={styles.fieldErrorMsg} role="alert">
              {attachmentError}
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.btn}
          disabled={submitting}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          aria-busy={submitting}
        >
          {submitting && <span className={styles.spinner} aria-hidden="true" />}
          {submitting ? "Sending…" : "Send feedback"}
        </button>
      </div>
    </>
  );

  // ---------------------------------------------------------------------------
  // Window surface root
  // ---------------------------------------------------------------------------

  if (!open) return null;

  return (
    <FormWindowSurface title="Send feedback">
      {succeeded ? renderSuccess() : renderForm()}
    </FormWindowSurface>
  );
}
