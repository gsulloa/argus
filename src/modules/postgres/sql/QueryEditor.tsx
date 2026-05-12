import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
} from "@codemirror/language";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { searchKeymap } from "@codemirror/search";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { composeSources } from "./completionSources";
import { formatSql } from "./format";
import styles from "./QueryEditor.module.css";

export interface QueryEditorHandle {
  /** Move the caret to a 0-based offset within the document. */
  setCursor(offset: number): void;
  /** Return the current full SQL text. */
  getSql(): string;
  /** Return `{ from, to }` of the current selection (single range only). */
  getSelectionRange(): { from: number; to: number };
  /** Return the cursor offset (0-based, anchor of main selection). */
  getCursor(): number;
  /** Move focus to the editor. */
  focus(): void;
  /** Re-bind the autocomplete sources to the current schema cache state.
   * Call this when `globalSchemaCache` notifies a relevant change. */
  reconfigureAutocomplete(): void;
  /** Format the entire buffer. Returns true on success, false on no-op or error. */
  formatBuffer(): boolean;
}

export interface QueryEditorProps {
  initialSql: string;
  /** Connection id — used to derive schema-aware completions from the cache. */
  connectionId: string;
  /** Debounced (~500ms) on text change. */
  onChange(sql: string): void;
  /** Called when the user presses Mod-Enter. */
  onRun(): void;
  /** Called when the user presses Mod-Shift-Enter (run all). */
  onRunAll(): void;
  /** Called when the user presses Mod-Shift-F (format the buffer). */
  onFormat(): void;
  /** Called when the user presses Mod-S (save). Optional — no-op if absent. */
  onSave?(): void;
}

/**
 * Mounts a CodeMirror 6 editor configured for Postgres SQL. The component
 * never re-creates the underlying `EditorView` from props — instead, prop
 * changes flow in via compartments so that, e.g., the completion source
 * can be swapped without losing editor state.
 *
 * The `initialSql` prop is honored only on first mount; subsequent updates
 * are ignored on purpose (the editor is the source of truth for its text;
 * the parent should not drive it externally beyond cursor moves).
 */
export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(
  function QueryEditor(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Two compartments: lang stays static (no re-parse on cache updates),
    // autocomplete is dynamic (rebuilds sources when the schema cache changes).
    const langCompartment = useRef(new Compartment());
    const autocompleteCompartment = useRef(new Compartment());
    const onChangeRef = useRef(props.onChange);
    onChangeRef.current = props.onChange;
    const onRunRef = useRef(props.onRun);
    onRunRef.current = props.onRun;
    const onRunAllRef = useRef(props.onRunAll);
    onRunAllRef.current = props.onRunAll;
    const onFormatRef = useRef(props.onFormat);
    onFormatRef.current = props.onFormat;
    const onSaveRef = useRef(props.onSave);
    onSaveRef.current = props.onSave;
    const connectionIdRef = useRef(props.connectionId);
    connectionIdRef.current = props.connectionId;

    // Set up the editor exactly once.
    useEffect(() => {
      if (!containerRef.current) return;
      let debounceTimer: number | null = null;
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (debounceTimer !== null) window.clearTimeout(debounceTimer);
          debounceTimer = window.setTimeout(() => {
            const next = update.state.doc.toString();
            onChangeRef.current(next);
          }, 500);
        }
      });
      // Tab is context-sensitive: accept active autocompletion suggestion
      // when the popup is open; otherwise indent. Shift-Tab always dedents.
      const tabBindings: KeyBinding[] = [
        {
          key: "Tab",
          preventDefault: true,
          run: (view) => {
            if (completionStatus(view.state) === "active") {
              return acceptCompletion(view);
            }
            return indentMore(view);
          },
        },
        {
          key: "Shift-Tab",
          preventDefault: true,
          run: indentLess,
        },
      ];
      // Wrap in `Prec.highest` so Mod-Enter / Mod-Shift-Enter and the Tab
      // bindings cannot be shadowed by any other extension's keymap.
      const customKeymap = Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              onRunRef.current();
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            preventDefault: true,
            run: () => {
              onRunAllRef.current();
              return true;
            },
          },
          {
            key: "Mod-Shift-f",
            preventDefault: true,
            run: () => {
              onFormatRef.current();
              return true;
            },
          },
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          ...tabBindings,
        ]),
      );

      const completionExtension = autocompletion({
        override: composeSources(props.connectionId),
      });

      const state = EditorState.create({
        doc: props.initialSql,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          langCompartment.current.of(
            sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
          ),
          autocompleteCompartment.current.of(completionExtension),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...searchKeymap,
          ]),
          customKeymap,
          updateListener,
          EditorView.theme({
            "&": { height: "100%", fontSize: "12.5px" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-content": { caretColor: "var(--accent)" },
            ".cm-cursor": { borderLeftColor: "var(--accent)" },
            // Editor selection. CM6 paints `.cm-selectionBackground` (a div
            // sitting behind the text) instead of native `::selection`, so
            // both selectors must be themed. Using a solid mid-opacity accent
            // tint so the highlight reads clearly against the dark editor
            // without obscuring the underlying syntax-highlighted text.
            ".cm-selectionBackground, ::selection": {
              background: "rgba(168, 85, 247, 0.45)",
            },
            "&.cm-focused .cm-selectionBackground": {
              background: "rgba(168, 85, 247, 0.55)",
            },
            ".cm-gutters": {
              background: "var(--surface)",
              borderRight: "1px solid var(--border)",
              color: "var(--text-subtle)",
            },
            ".cm-activeLine": { backgroundColor: "transparent" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            // Autocomplete popup: CM6 ships with a light-theme default that
            // renders unselected items invisible against our dark editor
            // (text color leaks from the app's global `color: var(--text)`
            // while the popup keeps its white background). Override the
            // tooltip + each item explicitly with our tokens.
            ".cm-tooltip": {
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text)",
            },
            ".cm-tooltip.cm-tooltip-autocomplete": {
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              borderRadius: "4px",
              boxShadow: "0 6px 16px rgba(0, 0, 0, 0.25)",
            },
            ".cm-tooltip-autocomplete > ul": {
              fontFamily: "var(--font-mono)",
              maxHeight: "20em",
              // Fixed width so the popup doesn't shrink to the typed prefix.
              // Long completions (qualified names, columns with comments)
              // need room; short prefixes shouldn't make the popup narrow.
              width: "440px",
            },
            ".cm-tooltip-autocomplete > ul > li": {
              color: "var(--text)",
              padding: "3px 8px",
              borderLeft: "2px solid transparent",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
              // Solid accent background + white text for unmistakable contrast.
              background: "var(--accent)",
              color: "#ffffff",
              borderLeftColor: "var(--accent)",
            },
            ".cm-completionIcon": {
              color: "var(--text-subtle)",
              opacity: 0.8,
              marginRight: "6px",
              width: "1em",
              textAlign: "center",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon": {
              color: "#ffffff",
              opacity: 1,
            },
            ".cm-completionLabel": { color: "var(--text)" },
            ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionLabel": {
              color: "#ffffff",
            },
            ".cm-completionMatchedText": {
              textDecoration: "none",
              color: "var(--accent)",
              fontWeight: 600,
            },
            // Matched-text accent collides with the selected row's accent
            // background; switch to a high-contrast underline + bold instead.
            ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText": {
              color: "#ffffff",
              textDecoration: "underline",
              textDecorationThickness: "2px",
              textUnderlineOffset: "2px",
            },
            ".cm-completionDetail": {
              color: "var(--text-subtle)",
              fontStyle: "normal",
              marginLeft: "8px",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": {
              // Slightly translucent so detail (data_type) doesn't compete
              // with the main label on the selected row.
              color: "rgba(255, 255, 255, 0.78)",
            },
            // Side panel showing column comments (`info` field).
            ".cm-tooltip.cm-completionInfo": {
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              padding: "6px 10px",
              maxWidth: "320px",
              fontFamily: "var(--font-sans, system-ui)",
              fontSize: "12px",
              lineHeight: 1.4,
            },
          }),
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;
      view.focus();

      return () => {
        if (debounceTimer !== null) window.clearTimeout(debounceTimer);
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      setCursor(offset: number) {
        const view = viewRef.current;
        if (!view) return;
        const len = view.state.doc.length;
        const clamped = Math.max(0, Math.min(offset, len));
        view.dispatch({
          selection: { anchor: clamped, head: clamped },
          scrollIntoView: true,
        });
        view.focus();
      },
      getSql() {
        return viewRef.current?.state.doc.toString() ?? "";
      },
      getSelectionRange() {
        const sel = viewRef.current?.state.selection.main;
        return { from: sel?.from ?? 0, to: sel?.to ?? 0 };
      },
      getCursor() {
        return viewRef.current?.state.selection.main.head ?? 0;
      },
      focus() {
        viewRef.current?.focus();
      },
      reconfigureAutocomplete() {
        const view = viewRef.current;
        if (!view) return;
        const next = autocompletion({
          override: composeSources(connectionIdRef.current),
        });
        view.dispatch({
          effects: autocompleteCompartment.current.reconfigure(next),
        });
      },
      formatBuffer() {
        const view = viewRef.current;
        if (!view) return false;
        const current = view.state.doc.toString();
        if (current.trim().length === 0) return false;
        const formatted = formatSql(current);
        if (formatted === current) return true;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: formatted },
          selection: { anchor: 0, head: 0 },
          scrollIntoView: true,
        });
        return true;
      },
    }));

    return <div ref={containerRef} className={styles.editor} />;
  },
);
