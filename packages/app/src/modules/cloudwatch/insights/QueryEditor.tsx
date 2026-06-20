/**
 * CloudWatch Logs Insights editor.
 *
 * CodeMirror 6 editor for `.cwlogs` queries with lightweight Insights
 * tokenizing: pipe `|`, command keywords (fields/filter/stats/sort/limit/
 * parse/display), and comments. No autocomplete from a schema.
 *
 * Exposes: getQuery() / getSql() / getCursor() / setCursor() / replaceBody() / focus() via ref.
 * The handle structurally satisfies ChatEditorHandle so the AI chat panel can
 * be mounted from any engine without per-engine wiring.
 */

import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
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
  StreamLanguage,
} from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { noAutoCorrectEditorAttrs } from "../../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Lightweight Insights tokenizer
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "fields", "filter", "stats", "sort", "limit", "parse", "display",
  "dedup", "pattern", "diff", "unmask",
]);

/**
 * StreamParser for Logs Insights query language.
 * Returns CM StreamParser type names which map to highlight classes.
 */
const cwlogsParser: StreamParser<null> = {
  name: "cwlogs",
  startState() {
    return null;
  },
  token(stream) {
    // Line comment (#)
    if (stream.match(/^#.*/)) return "comment";

    // Pipe operator
    if (stream.match("|")) return "operator";

    // Keywords and @-fields
    const wordMatch = stream.match(/^[a-zA-Z_@][a-zA-Z0-9_.@]*/);
    if (wordMatch) {
      const word = (wordMatch as RegExpMatchArray)[0];
      if (word && KEYWORDS.has(word.toLowerCase())) return "keyword";
      // @fields like @timestamp, @message
      if (word && word.startsWith("@")) return "variableName";
      return null;
    }

    // String literals
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'/)) return "string";

    // Numbers
    if (stream.match(/^-?[0-9]+(?:\.[0-9]+)?/)) return "number";

    // Comparison / arithmetic operators
    if (stream.match(/^[=!<>+\-*/]/)) return "operator";

    stream.next();
    return null;
  },
};

const cwlogsLanguage = StreamLanguage.define(cwlogsParser);

// Syntax highlighting CSS injected via EditorView.theme to match DESIGN.md
const cwlogsSyntaxTheme = EditorView.theme({
  ".cm-keyword": { color: "#C084FC" },           // Argus violet keyword
  ".cm-variableName": { color: "#93C5FD" },      // @timestamp/@message etc.
  ".cm-string": { color: "#86EFAC" },            // string literals
  ".cm-number": { color: "#F2F3F7" },            // numbers
  ".cm-comment": { color: "#6B6E7B", fontStyle: "italic" }, // # comments
  ".cm-operator": { color: "#A0A2AD" },          // operators
});

// ---------------------------------------------------------------------------
// Editor handle
// ---------------------------------------------------------------------------

export interface QueryEditorHandle {
  /** Returns the full editor document. Kept for existing callers in QueryTab.tsx. */
  getQuery(): string;
  /** Alias of getQuery(); satisfies ChatEditorHandle.getSql. */
  getSql(): string;
  /** Returns the current cursor offset (head of the primary selection). */
  getCursor(): number;
  /** Moves the cursor to the given offset. No-ops when the view is not mounted. */
  setCursor(offset: number): void;
  /** Replaces the entire document with `text`. No-ops when the view is not mounted. */
  replaceBody(text: string): void;
  focus(): void;
}

interface Props {
  initialQuery?: string;
  onChange?: (query: string) => void;
  onRun?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const QueryEditor = forwardRef<QueryEditorHandle, Props>(function QueryEditor(
  { initialQuery = "", onChange, onRun, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // The editor is created once on mount, so its keymap/listener would otherwise
  // close over the first render's callbacks. Keep the latest ones in refs so
  // Mod-Enter always runs with the current selection/time range.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    getQuery() {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    getSql() {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    getCursor() {
      return viewRef.current?.state.selection.main.head ?? 0;
    },
    setCursor(offset: number) {
      viewRef.current?.dispatch({ selection: { anchor: offset } });
    },
    replaceBody(text: string) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    focus() {
      viewRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const startState = EditorState.create({
      doc: initialQuery,
      extensions: [
        history(),
        lineNumbers(),
        highlightActiveLine(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        cwlogsSyntaxTheme,
        cwlogsLanguage,
        // Run binding must outrank the base keymap and any global handlers, so
        // it lives in a highest-precedence keymap (mirrors the MySQL/Athena
        // editors). `preventDefault` stops the event from bubbling out.
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                onRunRef.current?.();
                return true;
              },
            },
            { key: "Tab", preventDefault: true, run: indentMore },
            { key: "Shift-Tab", preventDefault: true, run: indentLess },
          ]),
        ),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: "13px",
          },
          ".cm-content": {
            padding: "8px 0",
          },
          ".cm-line": {
            padding: "0 12px",
          },
          ".cm-gutters": {
            background: "var(--canvas)",
            border: "none",
            color: "var(--text-subtle)",
          },
          ".cm-activeLineGutter": {
            background: "var(--surface-2)",
          },
          ".cm-activeLine": {
            background: "var(--surface-2)",
          },
          ".cm-focused": {
            outline: "none",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--text)",
          },
        }),
        noAutoCorrectEditorAttrs,
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    });
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
      className={className}
      style={{ height: "100%", overflow: "hidden" }}
    />
  );
});
