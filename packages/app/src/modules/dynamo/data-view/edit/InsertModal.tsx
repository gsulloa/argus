/**
 * InsertModal — task 8.1–8.7
 *
 * Modal for inserting a new DynamoDB item via dynamo.put_item.
 *
 * Views:
 *   - Form: typed key inputs (per AttributeDefinitions) + add-attribute rows.
 *   - Paste JSON: CodeMirror editor with tag/key-presence validation.
 * Right-hand pane: live JSON preview of the canonical draft.
 * Footer: "Allow overwrite" checkbox + Cancel + Confirm buttons.
 *
 * On success: close, toast, fire onSuccess (parent re-runs Scan/Query).
 * ConditionalCheckFailedException: stay open, highlight Allow-overwrite toggle.
 *
 * Design tokens: --accent, --danger, --bg-elevated, --bg-overlay, --border-strong.
 * Buttons: 6px 12px, 12-13px font, borderRadius 5.
 * Form labels: 11px uppercase, letterSpacing +0.14em (DESIGN.md).
 */

import { useEffect, useRef, useState } from "react";
import { noAutoCorrectProps } from "../../../shared/text-input-hygiene";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import type { AttributeMap } from "../types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import { dynamoPutItem } from "../api";
import { AppError } from "@/platform/errors/AppError";
import { useToast } from "@/platform/toast";
import { validateTaggedItem } from "./attr-equality";
import { noAutoCorrectEditorAttrs } from "../../../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsertModalProps {
  open: boolean;
  describe: TableDescription;
  indexName: string | null;
  connectionId: string;
  tableName: string;
  onClose: () => void;
  onSuccess: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type ViewMode = "form" | "json";

type AttrType = "S" | "N" | "BOOL" | "NULL";

interface ExtraAttr {
  id: string;
  name: string;
  type: AttrType;
  value: string;
  boolValue: boolean;
}

type ConflictError = {
  kind: "aws";
  message: string;
  awsCode?: string;
  highlightAllowOverwrite?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the KeySchema for the active index (or table primary). */
function resolveKeySchema(
  describe: TableDescription,
  indexName: string | null,
): TableDescription["key_schema"] {
  if (indexName !== null) {
    const gsi = describe.global_secondary_indexes.find(
      (g) => g.index_name === indexName,
    );
    if (gsi) return gsi.key_schema;
    const lsi = describe.local_secondary_indexes.find(
      (l) => l.index_name === indexName,
    );
    if (lsi) return lsi.key_schema;
  }
  return describe.key_schema;
}

/** Look up the AttributeType (S/N/B) for a key attribute name. */
function keyAttrType(
  describe: TableDescription,
  attrName: string,
): "S" | "N" | "B" {
  const def = describe.attribute_definitions.find(
    (d) => d.attribute_name === attrName,
  );
  return def?.attribute_type ?? "S";
}

/** Build a template JSON string for the Paste JSON editor. */
function buildJsonTemplate(
  describe: TableDescription,
  indexName: string | null,
): string {
  const schema = resolveKeySchema(describe, indexName);
  const obj: Record<string, unknown> = {};
  for (const k of schema) {
    const typ = keyAttrType(describe, k.attribute_name);
    obj[k.attribute_name] = { [typ]: "" };
  }
  return JSON.stringify(obj, null, 2);
}

/** Convert form state to AttributeMap. Returns null if any required field is empty. */
export function buildFormItem(
  keyFields: Array<{ name: string; type: "S" | "N" | "B"; value: string }>,
  extraAttrs: ExtraAttr[],
): AttributeMap | null {
  const item: AttributeMap = {};

  for (const kf of keyFields) {
    if (!kf.value.trim()) return null;
    if (kf.type === "S") item[kf.name] = { S: kf.value };
    else if (kf.type === "N") item[kf.name] = { N: kf.value };
    else item[kf.name] = { B: kf.value };
  }

  for (const attr of extraAttrs) {
    if (!attr.name.trim()) return null;
    if (attr.type === "S") {
      item[attr.name] = { S: attr.value };
    } else if (attr.type === "N") {
      item[attr.name] = { N: attr.value };
    } else if (attr.type === "BOOL") {
      item[attr.name] = { BOOL: attr.boolValue };
    } else {
      // NULL
      item[attr.name] = { NULL: true };
    }
  }

  return item;
}

/** Parse JSON draft and validate. Returns { item } or { error }. */
export function parseJsonDraft(
  text: string,
  keyNames: string[],
): { item: AttributeMap } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Invalid JSON: must be an object" };
  }

  const tagViolation = validateTaggedItem(parsed);
  if (tagViolation) {
    return {
      error: tagViolation.path
        ? `Untagged value at ${tagViolation.path}`
        : "Untagged value",
    };
  }

  const parsedMap = parsed as AttributeMap;
  for (const k of keyNames) {
    if (!parsedMap[k]) {
      return { error: `Missing key: ${k}` };
    }
  }

  return { item: parsedMap };
}

// ---------------------------------------------------------------------------
// CodeMirror JSON editor sub-component (for Paste JSON tab)
// ---------------------------------------------------------------------------

interface JsonEditorPaneProps {
  initialDoc: string;
  onChange: (text: string) => void;
  hasError: boolean;
  /** Test-only: override initial text without CodeMirror */
  _testInitialDraft?: string;
}

function JsonEditorPane({
  initialDoc,
  onChange,
  hasError,
  _testInitialDraft,
}: JsonEditorPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Test override: fire onChange immediately with the test draft
  const testDraftFired = useRef(false);
  useEffect(() => {
    if (_testInitialDraft !== undefined && !testDraftFired.current) {
      testDraftFired.current = true;
      onChangeRef.current(_testInitialDraft);
    }
  }, [_testInitialDraft]);

  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        json(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        noAutoCorrectEditorAttrs,
        EditorView.theme({
          "&": {
            fontSize: "12px",
            background: "var(--bg-elevated, var(--canvas, #0b0b0f))",
            fontFamily: "var(--font-mono, monospace)",
            height: "100%",
          },
          ".cm-content": {
            fontFamily: "var(--font-mono, monospace)",
            padding: "6px 0",
          },
          ".cm-gutters": { display: "none" },
          ".cm-line": { padding: "0 12px" },
          ".cm-focused": { outline: "none" },
          "::selection": { background: "rgba(168,85,247,0.25)" },
          ".cm-selectionBackground": { background: "rgba(168,85,247,0.2)" },
          "&.cm-focused .cm-selectionBackground": {
            background: "rgba(168,85,247,0.2)",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        height: "100%",
        overflow: "auto",
        border: `1px solid ${hasError ? "var(--danger, #f87171)" : "var(--border-strong, #2e2f3a)"}`,
        borderRadius: 5,
      }}
      aria-label="JSON editor"
    />
  );
}

// ---------------------------------------------------------------------------
// InsertModal component
// ---------------------------------------------------------------------------

export function InsertModal({
  open,
  describe,
  indexName,
  connectionId,
  tableName,
  onClose,
  onSuccess,
  onDirtyChange,
  _testJsonDraft,
}: InsertModalProps & { _testJsonDraft?: string }) {
  const toast = useToast();

  const keySchema = resolveKeySchema(describe, indexName);
  const keyNames = keySchema.map((k) => k.attribute_name);
  const pkName = describe.key_schema[0]?.attribute_name ?? keyNames[0] ?? "";

  // ── View ──────────────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>("form");

  // ── Form key fields ───────────────────────────────────────────────────────
  const [keyValues, setKeyValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of keySchema) init[k.attribute_name] = "";
    return init;
  });

  // ── Form extra attributes ─────────────────────────────────────────────────
  const [extraAttrs, setExtraAttrs] = useState<ExtraAttr[]>([]);

  // ── JSON draft ────────────────────────────────────────────────────────────
  const jsonTemplate = buildJsonTemplate(describe, indexName);
  // _testJsonDraft lets tests inject a draft without CodeMirror mounting
  const [jsonDraft, setJsonDraft] = useState<string>(
    _testJsonDraft !== undefined ? _testJsonDraft : jsonTemplate,
  );

  // Track what was fired (for test overrides)
  const [jsonEditorKey] = useState(0);

  // ── Allow overwrite ───────────────────────────────────────────────────────
  const [allowOverwrite, setAllowOverwrite] = useState(false);

  // ── Error / saving ────────────────────────────────────────────────────────
  const [error, setError] = useState<ConflictError | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Dirty tracking ────────────────────────────────────────────────────────
  const isDirty =
    view === "form"
      ? Object.values(keyValues).some((v) => v !== "") || extraAttrs.length > 0
      : jsonDraft !== jsonTemplate;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // ── Reset state when modal opens ──────────────────────────────────────────
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) {
      // Reset on reopen
      const init: Record<string, string> = {};
      for (const k of keySchema) init[k.attribute_name] = "";
      setKeyValues(init);
      setExtraAttrs([]);
      setJsonDraft(jsonTemplate);
      setView("form");
      setAllowOverwrite(false);
      setError(null);
    }
    prevOpen.current = open;
  });

  // ── Escape to close ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // ── Derive currentItem ───────────────────────────────────────────────────

  const keyFieldsArr = keySchema.map((k) => ({
    name: k.attribute_name,
    type: keyAttrType(describe, k.attribute_name),
    value: keyValues[k.attribute_name] ?? "",
  }));

  function currentItem(): AttributeMap | null {
    if (view === "form") {
      return buildFormItem(keyFieldsArr, extraAttrs);
    }
    const result = parseJsonDraft(jsonDraft, keyNames);
    return "item" in result ? result.item : null;
  }

  // ── JSON validation error (for paste-JSON pane) ───────────────────────────
  let jsonValidationError: string | null = null;
  if (view === "json") {
    const result = parseJsonDraft(jsonDraft, keyNames);
    if ("error" in result) jsonValidationError = result.error;
  }

  // ── Form validation ───────────────────────────────────────────────────────
  const emptyKeyFields = keyFieldsArr.filter((k) => !k.value.trim());
  const emptyAttrNames = extraAttrs.filter((a) => !a.name.trim());
  const formIsValid =
    emptyKeyFields.length === 0 && emptyAttrNames.length === 0;

  const confirmDisabled =
    saving ||
    (view === "form" ? !formIsValid : jsonValidationError !== null);

  // ── Confirm handler ───────────────────────────────────────────────────────

  async function handleConfirm() {
    const item = currentItem();
    if (!item) {
      setError({
        kind: "aws",
        message: "Please fill in all required fields.",
      });
      return;
    }

    const condition_expression = allowOverwrite
      ? null
      : `attribute_not_exists(#n0)`;
    const expression_attribute_names = allowOverwrite
      ? null
      : { "#n0": pkName };

    setSaving(true);
    setError(null);
    try {
      await dynamoPutItem(connectionId, tableName, {
        item,
        condition_expression,
        expression_attribute_names,
        expression_attribute_values: null,
        return_values: null,
      });
      toast.show("Item inserted", "success");
      onSuccess();
      onClose();
    } catch (e) {
      const err = e as AppError;
      const isAws =
        (err instanceof AppError && err.kind === "Aws") ||
        (typeof err === "object" &&
          err !== null &&
          (err as { kind?: string }).kind === "Aws");
      const awsCode =
        err instanceof AppError
          ? err.aws?.code
          : (err as { aws?: { code?: string } }).aws?.code;
      const message =
        (err as { message?: string }).message ?? "Insert failed";

      if (isAws && awsCode === "ConditionalCheckFailedException") {
        setError({
          kind: "aws",
          message:
            "An item with this key already exists. Enable 'Allow overwrite' to replace it.",
          awsCode: "ConditionalCheckFailedException",
          highlightAllowOverwrite: true,
        });
      } else {
        setError({
          kind: "aws",
          message,
          awsCode,
        });
      }
    } finally {
      setSaving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const previewItem = currentItem();
  let previewText: string;
  let previewIsError = false;
  if (previewItem) {
    previewText = JSON.stringify(previewItem, null, 2);
  } else if (view === "json" && jsonValidationError) {
    previewText = jsonValidationError;
    previewIsError = true;
  } else {
    previewText = "(fill in required fields)";
    previewIsError = true;
  }

  return (
    <div
      data-testid="insert-modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg-overlay, rgba(0,0,0,0.6))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="insert-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Insert item"
        style={{
          width: 780,
          maxWidth: "95vw",
          maxHeight: "85vh",
          background: "var(--bg-elevated, #15151b)",
          border: "1px solid var(--border-strong, #2e2f3a)",
          borderRadius: 6,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border, #23232c)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text, #f2f3f7)",
              flex: 1,
            }}
          >
            Insert item
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-subtle, #6b6e7b)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {tableName}
          </span>
        </div>

        {/* Tab strip */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderBottom: "1px solid var(--border, #23232c)",
            padding: "0 16px",
          }}
        >
          {(["form", "json"] as ViewMode[]).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`insert-tab-${v}`}
              onClick={() => setView(v)}
              style={{
                padding: "8px 12px",
                fontSize: 12,
                fontFamily: "inherit",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${view === v ? "var(--accent, #a855f7)" : "transparent"}`,
                color:
                  view === v
                    ? "var(--accent, #a855f7)"
                    : "var(--text-muted, #a0a2ad)",
                cursor: "pointer",
                fontWeight: view === v ? 500 : 400,
              }}
            >
              {v === "form" ? "Form" : "Paste JSON"}
            </button>
          ))}
        </div>

        {/* Body: input pane + preview pane side-by-side */}
        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {/* Left: input pane */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              padding: "14px 16px",
              borderRight: "1px solid var(--border, #23232c)",
            }}
          >
            {view === "form" ? (
              <FormPane
                keyFieldsArr={keyFieldsArr}
                keyValues={keyValues}
                onKeyValueChange={(name, val) =>
                  setKeyValues((prev) => ({ ...prev, [name]: val }))
                }
                extraAttrs={extraAttrs}
                onExtraAttrsChange={setExtraAttrs}
                describe={describe}
              />
            ) : (
              <div style={{ height: "300px" }}>
                <JsonEditorPane
                  key={jsonEditorKey}
                  initialDoc={jsonTemplate}
                  onChange={setJsonDraft}
                  hasError={jsonValidationError !== null}
                  _testInitialDraft={_testJsonDraft}
                />
                {jsonValidationError && (
                  <div
                    data-testid="json-validation-error"
                    style={{
                      marginTop: 6,
                      padding: "6px 10px",
                      fontSize: 11,
                      color: "var(--danger, #f87171)",
                      background: "rgba(248,113,113,0.07)",
                      borderRadius: 4,
                      border: "1px solid var(--danger, #f87171)",
                    }}
                  >
                    {jsonValidationError}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: JSON preview pane */}
          <div
            style={{
              width: 320,
              flexShrink: 0,
              padding: "14px 16px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                color: "var(--text-subtle, #6b6e7b)",
                fontFamily: "inherit",
                marginBottom: 4,
              }}
            >
              Preview
            </div>
            <pre
              data-testid="insert-preview"
              style={{
                margin: 0,
                padding: "8px 10px",
                fontSize: 11,
                fontFamily: "var(--font-mono, monospace)",
                background: "var(--canvas, #0b0b0f)",
                borderRadius: 4,
                border: "1px solid var(--border-strong, #2e2f3a)",
                color: previewIsError
                  ? "var(--text-muted, #a0a2ad)"
                  : "var(--text, #f2f3f7)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                flex: 1,
                minHeight: 80,
              }}
            >
              {previewText}
            </pre>
          </div>
        </div>

        {/* Error panel */}
        {error && (
          <div
            data-testid="insert-error"
            style={{
              margin: "0 16px 8px",
              padding: "6px 10px",
              fontSize: 11,
              color: "var(--danger, #f87171)",
              background: "rgba(248,113,113,0.07)",
              borderRadius: 4,
              border: "1px solid var(--danger, #f87171)",
            }}
          >
            {error.awsCode && error.awsCode !== error.message && (
              <strong style={{ marginRight: 6 }}>[{error.awsCode}]</strong>
            )}
            {error.message}
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderTop: "1px solid var(--border, #23232c)",
            gap: 8,
          }}
        >
          {/* Allow overwrite checkbox */}
          <label
            data-testid="allow-overwrite-label"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text-muted, #a0a2ad)",
              fontFamily: "inherit",
              userSelect: "none",
              padding: "4px 8px",
              borderRadius: 4,
              border: error?.highlightAllowOverwrite
                ? "1px solid var(--accent, #a855f7)"
                : "1px solid transparent",
              transition: "border-color 0.15s",
            }}
          >
            <input
              type="checkbox"
              data-testid="allow-overwrite-checkbox"
              checked={allowOverwrite}
              onChange={(e) => {
                setAllowOverwrite(e.target.checked);
                if (error?.highlightAllowOverwrite) setError(null);
              }}
              style={{ cursor: "pointer" }}
            />
            Allow overwrite
          </label>

          {/* Cancel + Confirm */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="insert-cancel-btn"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontFamily: "inherit",
                background: "transparent",
                border: "1px solid var(--border-strong, #2e2f3a)",
                borderRadius: 5,
                color: "var(--text-muted, #a0a2ad)",
                cursor: saving ? "default" : "pointer",
                opacity: saving ? 0.5 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="insert-confirm-btn"
              onClick={() => void handleConfirm()}
              disabled={confirmDisabled}
              title={confirmDisabled ? "Fill in all required fields" : "Insert item"}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontFamily: "inherit",
                background:
                  confirmDisabled
                    ? "rgba(168,85,247,0.4)"
                    : "var(--accent, #a855f7)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                cursor: confirmDisabled ? "default" : "pointer",
                fontWeight: 500,
              }}
            >
              {saving ? "Inserting…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormPane sub-component
// ---------------------------------------------------------------------------

interface FormPaneProps {
  keyFieldsArr: Array<{ name: string; type: "S" | "N" | "B"; value: string }>;
  keyValues: Record<string, string>;
  onKeyValueChange: (name: string, val: string) => void;
  extraAttrs: ExtraAttr[];
  onExtraAttrsChange: (next: ExtraAttr[]) => void;
  describe: TableDescription;
}

function FormPane({
  keyFieldsArr,
  keyValues,
  onKeyValueChange,
  extraAttrs,
  onExtraAttrsChange,
  describe: _describe,
}: FormPaneProps) {
  function addAttr() {
    onExtraAttrsChange([
      ...extraAttrs,
      {
        id: String(Date.now()),
        name: "",
        type: "S",
        value: "",
        boolValue: false,
      },
    ]);
  }

  function removeAttr(id: string) {
    onExtraAttrsChange(extraAttrs.filter((a) => a.id !== id));
  }

  function patchAttr(id: string, patch: Partial<ExtraAttr>) {
    onExtraAttrsChange(
      extraAttrs.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  }

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: "var(--text-subtle, #6b6e7b)",
    marginBottom: 4,
    fontFamily: "inherit",
  };

  const inputStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "6px 10px",
    fontSize: 12,
    fontFamily: "var(--font-mono, monospace)",
    background: "var(--canvas, #0b0b0f)",
    border: "1px solid var(--border-strong, #2e2f3a)",
    borderRadius: 4,
    color: "var(--text, #f2f3f7)",
    outline: "none",
    boxSizing: "border-box",
  };

  const invalidInputStyle: React.CSSProperties = {
    ...inputStyle,
    border: "1px solid var(--danger, #f87171)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Key fields */}
      <div>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "var(--text-subtle, #6b6e7b)",
            marginBottom: 8,
            fontFamily: "inherit",
          }}
        >
          Key attributes
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {keyFieldsArr.map((kf) => {
            const isEmpty = !keyValues[kf.name]?.trim();
            return (
              <div key={kf.name}>
                <label style={labelStyle}>
                  {kf.name}{" "}
                  <span style={{ color: "var(--text-muted, #a0a2ad)", textTransform: "none", letterSpacing: 0 }}>
                    ({kf.type})
                  </span>
                  {" "}
                  <span style={{ color: "var(--danger, #f87171)" }}>*</span>
                </label>
                <input
                  type={kf.type === "N" ? "text" : "text"}
                  {...noAutoCorrectProps}
                  inputMode={kf.type === "N" ? "decimal" : "text"}
                  data-testid={`key-input-${kf.name}`}
                  value={keyValues[kf.name] ?? ""}
                  onChange={(e) => onKeyValueChange(kf.name, e.target.value)}
                  placeholder={kf.type === "N" ? "0" : `Enter ${kf.name}`}
                  style={isEmpty ? invalidInputStyle : inputStyle}
                  autoFocus={keyFieldsArr[0]?.name === kf.name}
                />
                {isEmpty && (
                  <div
                    data-testid={`key-error-${kf.name}`}
                    style={{
                      fontSize: 11,
                      color: "var(--danger, #f87171)",
                      marginTop: 3,
                    }}
                  >
                    {kf.name} is required
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Extra attributes */}
      {extraAttrs.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--text-subtle, #6b6e7b)",
              marginBottom: 8,
              fontFamily: "inherit",
            }}
          >
            Additional attributes
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {extraAttrs.map((attr) => (
              <ExtraAttrRow
                key={attr.id}
                attr={attr}
                onChange={(patch) => patchAttr(attr.id, patch)}
                onRemove={() => removeAttr(attr.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Add attribute button */}
      <button
        type="button"
        data-testid="add-attribute-btn"
        onClick={addAttr}
        style={{
          padding: "5px 10px",
          fontSize: 11,
          fontFamily: "inherit",
          background: "transparent",
          border: "1px solid var(--border-strong, #2e2f3a)",
          borderRadius: 4,
          color: "var(--text-muted, #a0a2ad)",
          cursor: "pointer",
          alignSelf: "flex-start",
        }}
      >
        + Add attribute
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExtraAttrRow
// ---------------------------------------------------------------------------

interface ExtraAttrRowProps {
  attr: ExtraAttr;
  onChange: (patch: Partial<ExtraAttr>) => void;
  onRemove: () => void;
}

function ExtraAttrRow({ attr, onChange, onRemove }: ExtraAttrRowProps) {
  const inputStyle: React.CSSProperties = {
    padding: "5px 8px",
    fontSize: 12,
    fontFamily: "var(--font-mono, monospace)",
    background: "var(--canvas, #0b0b0f)",
    border: "1px solid var(--border-strong, #2e2f3a)",
    borderRadius: 4,
    color: "var(--text, #f2f3f7)",
    outline: "none",
  };

  return (
    <div
      style={{ display: "flex", gap: 6, alignItems: "center" }}
      data-testid="extra-attr-row"
    >
      {/* Name */}
      <input
        type="text"
        {...noAutoCorrectProps}
        data-testid="extra-attr-name"
        value={attr.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="attribute name"
        style={{
          ...inputStyle,
          flex: 1,
          border:
            !attr.name.trim()
              ? "1px solid var(--danger, #f87171)"
              : inputStyle.border,
        }}
      />

      {/* Type */}
      <select
        data-testid="extra-attr-type"
        value={attr.type}
        onChange={(e) => onChange({ type: e.target.value as AttrType })}
        style={{
          ...inputStyle,
          width: 70,
          cursor: "pointer",
        }}
      >
        <option value="S">S</option>
        <option value="N">N</option>
        <option value="BOOL">BOOL</option>
        <option value="NULL">NULL</option>
      </select>

      {/* Value */}
      {attr.type === "NULL" ? null : attr.type === "BOOL" ? (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
            color: "var(--text-muted, #a0a2ad)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            data-testid="extra-attr-bool"
            checked={attr.boolValue}
            onChange={(e) => onChange({ boolValue: e.target.checked })}
          />
          {attr.boolValue ? "true" : "false"}
        </label>
      ) : (
        <input
          type="text"
          {...noAutoCorrectProps}
          inputMode={attr.type === "N" ? "decimal" : "text"}
          data-testid="extra-attr-value"
          value={attr.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder={attr.type === "N" ? "0" : "value"}
          style={{ ...inputStyle, flex: 1 }}
        />
      )}

      {/* Remove */}
      <button
        type="button"
        data-testid="extra-attr-remove"
        onClick={onRemove}
        style={{
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "1px solid var(--border-strong, #2e2f3a)",
          borderRadius: 4,
          color: "var(--text-muted, #a0a2ad)",
          cursor: "pointer",
          fontSize: 14,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
