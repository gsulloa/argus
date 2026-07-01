import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import type { TableStructureCache } from "./useTableStructureCache";
import styles from "./RawSubtab.module.css";
import { writeClipboardText, COPY_FAILED_MESSAGE } from "@/platform/clipboard";
import { useToast } from "@/platform/toast";

interface Props {
  schema: string;
  relation: string;
  cache: TableStructureCache;
}

export function RawSubtab({ schema, relation, cache }: Props) {
  useEffect(() => {
    if (cache.state.status === "idle") {
      void cache.ensureLoaded("user");
    }
  }, [cache]);

  const ddl = cache.state.response?.ddl ?? "";
  const isBestEffort = cache.state.response?.is_best_effort ?? false;

  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const onCopy = async () => {
    if (!ddl) return;
    const ok = await writeClipboardText(ddl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.show(COPY_FAILED_MESSAGE, "error");
    }
  };

  const onRefresh = () => {
    void cache.refresh("user");
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>
            {schema}.{relation}
          </span>
          <span className={styles.subtitle}>
            Reconstructed DDL — not a <code>pg_dump</code> substitute.
          </span>
          {isBestEffort ? (
            <span className={styles.bestEffort}>
              Best effort — this relation has features the reconstruction may
              simplify.
            </span>
          ) : null}
        </div>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={styles.btn}
            onClick={onCopy}
            disabled={!ddl}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={onRefresh}
            disabled={cache.state.status === "loading"}
            aria-label="Refresh structure"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        </div>
      </header>
      {cache.state.status === "loading" && cache.state.response === null ? (
        <div className={styles.loading}>
          <Loader2 className={styles.spinner} size={14} />
          Loading DDL…
        </div>
      ) : cache.state.status === "error" && cache.state.response === null ? (
        <div className={styles.errorBanner} role="alert">
          {cache.state.error?.message ?? "Failed to load DDL."}
          <button type="button" className={styles.retryBtn} onClick={onRefresh}>
            Retry
          </button>
        </div>
      ) : (
        <ReadOnlyDdlEditor value={ddl} />
      )}
    </div>
  );
}

function ReadOnlyDdlEditor({ value }: { value: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // First-mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Out-of-band sync when the DDL string changes (Refresh).
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
      className={styles.editor}
      role="textbox"
      aria-label="Reconstructed DDL"
      aria-readonly="true"
    />
  );
}
