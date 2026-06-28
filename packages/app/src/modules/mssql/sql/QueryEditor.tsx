/**
 * §20.1 — MS SQL Server QueryEditor component.
 *
 * CodeMirror 6 editor configured for T-SQL. Uses the MSSQL dialect from
 * @codemirror/lang-sql which ships T-SQL keyword highlighting out of the box.
 *
 * Key bindings:
 *   Mod-Enter       → onRun (run statement under cursor / selection)
 *   Mod-Shift-Enter → onRunAll (run all statements)
 *   Mod-s           → onSave (optional)
 *
 * Error mark: §20.5 — when the backend returns a line-level error, the caller
 * dispatches setErrorMark({ from, to }) to underline the offending range.
 * The line is server-reported *per batch*; the caller computes the offset.
 */

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
import { sql, MSSQL } from "@codemirror/lang-sql";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { composeSources } from "./completionSources";
import { formatSql } from "./format";
import { noAutoCorrectEditorAttrs } from "../../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Error-position underline decoration (§20.5)
// ---------------------------------------------------------------------------

export interface ErrorMark {
  /** 0-based character offset (backend returns 1-based line; callers must convert). */
  from: number;
  /** Exclusive end. */
  to: number;
}

const setErrorMark = StateEffect.define<ErrorMark | null>();

const errorMarkField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setErrorMark)) {
        if (!effect.value) {
          marks = Decoration.none;
        } else {
          const { from, to } = effect.value;
          const len = tr.newDoc.length;
          const clampedFrom = Math.max(0, Math.min(from, len));
          const clampedTo = Math.max(clampedFrom, Math.min(to, len));
          if (clampedFrom < clampedTo) {
            marks = Decoration.set([
              Decoration.mark({ class: "cm-errorUnderline" }).range(clampedFrom, clampedTo),
            ]);
          } else {
            marks = Decoration.none;
          }
        }
      }
    }
    return marks;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

// ---------------------------------------------------------------------------
// Public handle / props
// ---------------------------------------------------------------------------

export interface QueryEditorHandle {
  setCursor(offset: number): void;
  getSql(): string;
  getSelectionRange(): { from: number; to: number };
  getCursor(): number;
  focus(): void;
  reconfigureAutocomplete(): void;
  /** Set or clear the error-position underline. Pass null to clear. */
  setErrorMark(mark: ErrorMark | null): void;
  /** Format the entire buffer in-place with the T-SQL formatter (§20.10). */
  formatBuffer(): void;
  /** Replace the entire editor buffer with the given text (used by ParamStrip "Insert into editor"). */
  replaceBody(text: string): void;
}

export interface QueryEditorProps {
  initialSql: string;
  connectionId: string;
  onChange(sql: string): void;
  onRun(): void;
  onRunAll(): void;
  onSave?(): void;
  onFormat?(): void;
  /** Called when the user presses Mod-. or Escape (cancel in-flight query). Optional. */
  onCancel?(): void;
}

export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(
  function QueryEditor(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const langCompartment = useRef(new Compartment());
    const autocompleteCompartment = useRef(new Compartment());
    const onChangeRef = useRef(props.onChange);
    onChangeRef.current = props.onChange;
    const onRunRef = useRef(props.onRun);
    onRunRef.current = props.onRun;
    const onRunAllRef = useRef(props.onRunAll);
    onRunAllRef.current = props.onRunAll;
    const onSaveRef = useRef(props.onSave);
    onSaveRef.current = props.onSave;
    const onFormatRef = useRef(props.onFormat);
    onFormatRef.current = props.onFormat;
    const onCancelRef = useRef(props.onCancel);
    onCancelRef.current = props.onCancel;
    const connectionIdRef = useRef(props.connectionId);
    connectionIdRef.current = props.connectionId;

    useEffect(() => {
      if (!containerRef.current) return;
      let debounceTimer: number | null = null;

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (debounceTimer !== null) window.clearTimeout(debounceTimer);
          debounceTimer = window.setTimeout(() => {
            onChangeRef.current(update.state.doc.toString());
          }, 500);
        }
      });

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
        { key: "Shift-Tab", preventDefault: true, run: indentLess },
      ];

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
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          {
            key: "Mod-Shift-f",
            preventDefault: true,
            run: () => {
              onFormatRef.current?.();
              return true;
            },
          },
          {
            key: "Mod-.",
            preventDefault: true,
            run: () => {
              onCancelRef.current?.();
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              if (onCancelRef.current) {
                onCancelRef.current();
                return true;
              }
              return false;
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
          errorMarkField,
          langCompartment.current.of(sql({ dialect: MSSQL })),
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
          noAutoCorrectEditorAttrs,
          EditorView.theme({
            "&": { height: "100%", fontSize: "12.5px" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-content": { caretColor: "var(--accent)" },
            ".cm-cursor": { borderLeftColor: "var(--accent)" },
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
            // Error underline (§20.5)
            ".cm-errorUnderline": {
              textDecoration: "underline wavy red",
              textDecorationSkipInk: "none",
            },
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
              width: "440px",
            },
            ".cm-tooltip-autocomplete > ul > li": {
              color: "var(--text)",
              padding: "3px 8px",
              borderLeft: "2px solid transparent",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
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
              color: "rgba(255, 255, 255, 0.78)",
            },
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
      setErrorMark(mark: ErrorMark | null) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: setErrorMark.of(mark) });
      },
      formatBuffer() {
        const view = viewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        const formatted = formatSql(current);
        if (formatted === current) return;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: formatted },
        });
      },
      replaceBody(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const len = view.state.doc.length;
        view.dispatch({
          changes: { from: 0, to: len, insert: text },
          selection: { anchor: 0, head: 0 },
          scrollIntoView: true,
        });
        view.focus();
      },
    }));

    return (
      <div
        ref={containerRef}
        style={{ height: "100%", overflow: "hidden" }}
      />
    );
  },
);
