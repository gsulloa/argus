/**
 * InspectorJsonEditor — task 7.2 / 7.3 / 7.4 / 7.5
 *
 * CodeMirror JSON editor for editing a DynamoDB item in tagged AttributeValue form.
 *
 * Responsibilities:
 *   - Preload editor with JSON.stringify(item, null, 2).
 *   - Parse → tag-validate → key-check → diff or replace → dispatch.
 *   - "Replace entire item" toggle (default off) routes to dynamo.put_item.
 *   - Inline error panel with "Reload row" on ConditionalCheckFailedException.
 *   - ⌘S / Ctrl+S fires Save.
 *   - Cancel fires onClose.
 *
 * Design tokens: --accent, --danger, --bg-elevated, --border-strong, --text-muted.
 * Buttons: 6px 12px, 12-13px font, borderRadius 5.
 */

import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import type { AttributeMap } from "../types";
import { dynamoUpdateItem, dynamoPutItem, dynamoQuery } from "../api";
import { AppError } from "@/platform/errors/AppError";
import { useToast } from "@/platform/toast";
import {
  attrValueEquals,
  diffAttributeMaps,
  validateTaggedItem,
} from "./attr-equality";
import { buildLockingCondition } from "./lockingCondition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockingProps {
  versionAttr: string;
  enabled: boolean;
  pkAttr: string;
}

export interface InspectorJsonEditorProps {
  item: AttributeMap;
  keyNames: string[];
  connectionId: string;
  tableName: string;
  rowIndex: number;
  onClose: () => void;
  onPatchItem: (rowIndex: number, next: AttributeMap) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Optimistic locking config (task 10.5). */
  locking?: LockingProps;
  /**
   * Test-only: override the initial draft text (bypasses CodeMirror content).
   * Used in unit tests where CodeMirror is mocked and doesn't fire updateListener.
   */
  _testInitialDraft?: string;
}

type EditorError = {
  kind: "parse" | "tag" | "key" | "aws";
  message: string;
  awsCode?: string;
};

// ---------------------------------------------------------------------------
// Pure helper: extract just the key fields from an item
// ---------------------------------------------------------------------------

export function extractKey(item: AttributeMap, keyNames: string[]): AttributeMap {
  const key: AttributeMap = {};
  for (const k of keyNames) {
    if (item[k] !== undefined) {
      key[k] = item[k]!;
    }
  }
  return key;
}

// ---------------------------------------------------------------------------
// Pure helper: build key condition expression placeholders for dynamoQuery
// ---------------------------------------------------------------------------

export function buildKeyConditionPlaceholders(
  keyNames: string[],
  key: AttributeMap,
): {
  expression: string;
  names: Record<string, string>;
  values: AttributeMap;
} {
  const names: Record<string, string> = {};
  const values: AttributeMap = {};
  const parts: string[] = [];

  keyNames.forEach((k, i) => {
    const namePh = `#k${i}`;
    const valPh = `:k${i}`;
    names[namePh] = k;
    if (key[k] !== undefined) {
      values[valPh] = key[k]!;
    }
    parts.push(`${namePh} = ${valPh}`);
  });

  return {
    expression: parts.join(" AND "),
    names,
    values,
  };
}

// ---------------------------------------------------------------------------
// Pure validation + diff decision helper (testable without mounting)
// ---------------------------------------------------------------------------

export type SaveAction =
  | { kind: "error"; error: EditorError }
  | { kind: "no-change" }
  | { kind: "update"; diff: { set: AttributeMap; remove: string[] }; key: AttributeMap }
  | { kind: "replace"; parsed: AttributeMap };

export function computeSaveAction(
  draftText: string,
  originalItem: AttributeMap,
  keyNames: string[],
  replaceEntireItem: boolean,
): SaveAction {
  // 1. Parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(draftText);
  } catch (e) {
    return {
      kind: "error",
      error: {
        kind: "parse",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  // 2. Must be a plain object
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      kind: "error",
      error: { kind: "parse", message: "Item must be a JSON object" },
    };
  }

  // 3. Tag validation
  const tagViolation = validateTaggedItem(parsed);
  if (tagViolation) {
    const atPath = tagViolation.path ? ` at ${tagViolation.path}` : "";
    return {
      kind: "error",
      error: { kind: "tag", message: `Untagged or invalid value${atPath}` },
    };
  }

  const parsedMap = parsed as AttributeMap;

  // 4. Key equality check
  for (const k of keyNames) {
    const parsedKey = parsedMap[k];
    const originalKey = originalItem[k];
    if (!parsedKey || !originalKey || !attrValueEquals(parsedKey, originalKey)) {
      return {
        kind: "error",
        error: {
          kind: "key",
          message: "Changing the primary key is a delete + insert, not an edit",
        },
      };
    }
  }

  // 5. Replace mode
  if (replaceEntireItem) {
    return { kind: "replace", parsed: parsedMap };
  }

  // 6. Diff mode
  const diff = diffAttributeMaps(originalItem, parsedMap);
  if (Object.keys(diff.set).length === 0 && diff.remove.length === 0) {
    return { kind: "no-change" };
  }

  const key = extractKey(originalItem, keyNames);
  return { kind: "update", diff, key };
}

// ---------------------------------------------------------------------------
// InspectorJsonEditor component
// ---------------------------------------------------------------------------

export function InspectorJsonEditor({
  item,
  keyNames,
  connectionId,
  tableName,
  rowIndex,
  onClose,
  onPatchItem,
  onDirtyChange,
  locking,
  _testInitialDraft,
}: InspectorJsonEditorProps) {
  const toast = useToast();

  // The original serialized text (used to init the editor and detect dirty)
  const [originalSerialized] = useState<string>(() =>
    JSON.stringify(item, null, 2),
  );

  // originalItem as state so Reload row can update the diff base
  const [originalItem, setOriginalItem] = useState<AttributeMap>(item);

  // Current editor text — synced by CM update listener
  // _testInitialDraft allows tests to override when CM is mocked
  const [draft, setDraft] = useState<string>(
    _testInitialDraft !== undefined ? _testInitialDraft : originalSerialized,
  );

  // Toggle: Replace entire item vs diff-update
  const [replaceEntireItem, setReplaceEntireItem] = useState(false);

  // In-flight save
  const [saving, setSaving] = useState(false);

  // Inline error
  const [error, setError] = useState<EditorError | null>(null);

  // CodeMirror refs
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep a ref to draft for use in the save handler inside CodeMirror keymap
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Keep refs to avoid stale closures
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  // Notify dirty state
  useEffect(() => {
    onDirtyChange?.(draft !== originalSerialized);
  }, [draft, originalSerialized, onDirtyChange]);

  // ── Save handler ──────────────────────────────────────────────────────────
  // Defined as a stable callback stored in a ref, so the CM keymap can call it
  // without capturing a stale closure.

  const handleSaveRef = useRef<() => Promise<void>>(async () => {
    /* filled below */
  });

  // ── Mount CodeMirror ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const state = EditorState.create({
      doc: originalSerialized,
      extensions: [
        history(),
        keymap.of([
          // ⌘S / Ctrl+S → Save
          {
            key: "Mod-s",
            run: () => {
              void handleSaveRef.current();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        json(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            setDraft(text);
            draftRef.current = text;
          }
        }),
        EditorView.theme({
          "&": {
            fontSize: "12px",
            background: "var(--bg-elevated, var(--canvas, #0b0b0f))",
            fontFamily: "var(--font-mono, monospace)",
            border: "1px solid var(--border-strong, #2e2f3a)",
            borderRadius: "5px",
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

  // ── Wiring handleSave after state is available ────────────────────────────

  useEffect(() => {
    handleSaveRef.current = async () => {
      if (savingRef.current) return;

      const action = computeSaveAction(
        draftRef.current,
        originalItem,
        keyNames,
        replaceEntireItem,
      );

      if (action.kind === "error") {
        setError(action.error);
        return;
      }

      if (action.kind === "no-change") {
        toast.show("No changes", "info");
        onCloseRef.current();
        return;
      }

      setError(null);
      setSaving(true);
      savingRef.current = true;

      try {
        if (action.kind === "replace") {
          await dynamoPutItem(connectionId, tableName, {
            item: action.parsed,
            condition_expression: null,
            expression_attribute_names: null,
            expression_attribute_values: null,
            return_values: null,
          });
          onPatchItem(rowIndex, action.parsed);
          onCloseRef.current();
        } else {
          // action.kind === "update"
          // ── Optimistic locking condition (task 10.5) ───────────────────────
          let conditionExpression: string | null = null;
          let conditionNames: Record<string, string> | null = null;
          let conditionValues: import("../types").AttributeMap | null = null;

          if (locking?.enabled && locking.versionAttr) {
            const prevValue = originalItem[locking.versionAttr];
            const lockResult = buildLockingCondition(
              locking.versionAttr,
              prevValue,
              locking.pkAttr,
            );
            if (lockResult) {
              conditionExpression = lockResult.condition_expression;
              conditionNames = lockResult.expression_attribute_names;
              conditionValues = lockResult.expression_attribute_values;
            }
          }

          const resp = await dynamoUpdateItem(connectionId, tableName, {
            key: action.key,
            updates: action.diff,
            condition_expression: conditionExpression,
            expression_attribute_names: conditionNames,
            expression_attribute_values: conditionValues,
            return_values: "ALL_NEW",
          });
          if (resp.attributes) onPatchItem(rowIndex, resp.attributes);
          onCloseRef.current();
        }
      } catch (e) {
        const err = e instanceof AppError ? e : (() => {
          const ae = e as { kind?: string; aws?: { code?: string }; message?: string };
          return ae;
        })();

        // Check if it is an AppError (or duck-typed equivalent from tests)
        const isAppErr = err instanceof AppError;
        const isAws = isAppErr
          ? (err as AppError).kind === "Aws"
          : (err as { kind?: string }).kind === "Aws";
        const awsCode = isAppErr
          ? (err as AppError).aws?.code
          : (err as { aws?: { code?: string } }).aws?.code;
        const message = (err as { message?: string }).message ?? "Update failed";

        if (isAws && awsCode === "ConditionalCheckFailedException") {
          setError({
            kind: "aws",
            message,
            awsCode: "ConditionalCheckFailedException",
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
        savingRef.current = false;
      }
    };
  }, [originalItem, keyNames, replaceEntireItem, connectionId, tableName, rowIndex, onPatchItem, toast, locking]);

  // ── Reload row ───────────────────────────────────────────────────────────

  async function reloadRow() {
    const key = extractKey(originalItem, keyNames);
    const placeholders = buildKeyConditionPlaceholders(keyNames, key);

    try {
      const resp = await dynamoQuery(connectionId, tableName, {
        index_name: null,
        limit: 1,
        page: 0,
        exclusive_start_key: null,
        key_condition_expression: placeholders.expression,
        filter_expression: null,
        expression_attribute_names: placeholders.names,
        expression_attribute_values: placeholders.values,
        projection_expression: null,
        consistent_read: true,
        select: null,
        scan_index_forward: null,
      });

      if (resp.items.length === 0) {
        setError({
          kind: "aws",
          message: "Row no longer exists. Cancel to dismiss draft.",
          awsCode: "NotFound",
        });
        return;
      }

      const fresh = resp.items[0]!;
      setOriginalItem(fresh);
      onPatchItem(rowIndex, fresh);
      setError(null);
      toast.show("Row reloaded — review and Save again", "info");
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : (e as { message?: string })?.message ?? "Reload failed";
      setError({ kind: "aws", message: msg });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const hasError = error !== null;
  const editorBorderColor = hasError
    ? "var(--danger, #f87171)"
    : "var(--border-strong, #2e2f3a)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        gap: 0,
      }}
      data-testid="inspector-json-editor"
    >
      {/* Editor area */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          borderRadius: 5,
          overflow: "hidden",
          border: `1px solid ${editorBorderColor}`,
        }}
      >
        <div
          ref={containerRef}
          style={{ height: "100%", overflow: "auto" }}
          aria-label="JSON editor"
        />
      </div>

      {/* Error panel */}
      {error && (
        <div
          data-testid="editor-error"
          style={{
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--danger, #f87171)",
            background: "rgba(248,113,113,0.07)",
            borderRadius: 4,
            marginTop: 6,
            border: `1px solid var(--danger, #f87171)`,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, wordBreak: "break-word" }}>
            {error.awsCode && error.awsCode !== error.message && (
              <strong style={{ marginRight: 6 }}>[{error.awsCode}]</strong>
            )}
            {error.message}
          </span>
          {error.awsCode === "ConditionalCheckFailedException" && (
            <button
              type="button"
              data-testid="reload-row-btn"
              onClick={() => void reloadRow()}
              style={{
                padding: "3px 8px",
                fontSize: 11,
                fontFamily: "inherit",
                background: "transparent",
                border: "1px solid var(--danger, #f87171)",
                borderRadius: 4,
                color: "var(--danger, #f87171)",
                cursor: "pointer",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              Reload row
            </button>
          )}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 8,
          flexShrink: 0,
        }}
      >
        {/* Replace entire item toggle */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-sans, system-ui)",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            data-testid="replace-entire-toggle"
            checked={replaceEntireItem}
            onChange={(e) => setReplaceEntireItem(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          Replace entire item
        </label>

        {/* Cancel / Save buttons */}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            data-testid="editor-cancel-btn"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontFamily: "inherit",
              background: "transparent",
              border: "1px solid var(--border-strong, #2e2f3a)",
              borderRadius: 5,
              color: "var(--text-muted)",
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="editor-save-btn"
            onClick={() => void handleSaveRef.current()}
            disabled={saving}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontFamily: "inherit",
              background: saving
                ? "rgba(168,85,247,0.5)"
                : "var(--accent, #a855f7)",
              border: "none",
              borderRadius: 5,
              color: "#fff",
              cursor: saving ? "default" : "pointer",
              fontWeight: 500,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
