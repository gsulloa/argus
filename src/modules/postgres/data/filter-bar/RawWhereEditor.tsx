import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import styles from "./FilterBar.module.css";

interface Props {
  value: string;
  onChange(next: string): void;
}

/**
 * CodeMirror 6 editor scoped to a `WHERE` body. Postgres SQL syntax
 * highlighting only — no autocomplete extension, no run keymap. The `value`
 * prop is honored on first mount and on out-of-band updates (e.g. seeding
 * after a Structured → Raw mode toggle); the editor is otherwise the source
 * of truth for its own text.
 */
export function RawWhereEditor({ value, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // First-mount only — `value` becomes the editor's own state after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Out-of-band sync: when the parent rewrites `value` (mode-toggle seeding,
  // Reset clearing the body), reflect it in the editor without losing the
  // editor instance.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={styles.rawEditor}
      role="textbox"
      aria-label="Raw WHERE clause"
      data-filter-focus-target="true"
    />
  );
}
