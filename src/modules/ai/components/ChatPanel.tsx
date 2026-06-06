/**
 * ChatPanel — docked AI chat panel for the Postgres SQL editor.
 *
 * Renders null when `open === false`. Mints a ChatSession on first open,
 * reuses it across re-renders, and closes it on unmount.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { QueryEditorHandle } from "@/modules/postgres/sql/QueryEditor";
import { ChatSession } from "@/modules/ai/session";
import { useAiSettings, useResolvedProviderId } from "@/modules/ai/store";
import { PROVIDER_LABELS, type ProviderId } from "@/modules/ai/types";
import type { ChatTurn, ToolUseRecord } from "@/modules/ai/types";
import { captureResult, type AttachedResult } from "@/modules/ai/attachments";

import styles from "./ChatPanel.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  contextPath: string | null;
  editorRef: React.RefObject<QueryEditorHandle>;
  /** Live executed result from the surrounding QueryTab, available to attach as context. */
  result?: {
    columns: string[];
    rows: import("@/modules/postgres/data/types").CellValue[][];
    truncated: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers: code block parsing
// ---------------------------------------------------------------------------

const FENCE_RE = /```(\w+)?\n([\s\S]*?)```/g;

type Segment =
  | { kind: "text"; content: string }
  | { kind: "code"; lang: string | null; code: string };

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  FENCE_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({
      kind: "code",
      lang: match[1] ?? null,
      code: match[2] ?? "",
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

function isSqlLike(lang: string | null): boolean {
  return lang === null || lang === "sql" || lang === "SQL";
}


// ---------------------------------------------------------------------------
// Helpers: model resolution
// ---------------------------------------------------------------------------

function getModelForProvider(
  providerId: ProviderId,
  settings: {
    claude_cli_model: string | null;
    codex_cli_model: string | null;
    anthropic_api_model: string | null;
    openai_api_model: string | null;
  } | null,
): string | null {
  if (!settings) return null;
  switch (providerId) {
    case "claude-cli":
      return settings.claude_cli_model;
    case "codex-cli":
      return settings.codex_cli_model;
    case "anthropic-api":
      return settings.anthropic_api_model;
    case "openai-api":
      return settings.openai_api_model;
  }
}

// ---------------------------------------------------------------------------
// CodeBlock sub-component
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  code: string;
  lang: string | null;
  editorRef: React.RefObject<QueryEditorHandle>;
  applied?: boolean;
  onApply?: () => void;
}

function CodeBlock({ code, lang, editorRef, applied, onApply }: CodeBlockProps) {
  const canApply = isSqlLike(lang);

  const handleApply = useCallback(() => {
    const trimmed = code.trim();
    editorRef.current?.replaceBody(trimmed);
    const len = (editorRef.current?.getSql() ?? "").length;
    editorRef.current?.setCursor(len);
    onApply?.();
  }, [code, editorRef, onApply]);

  const handleInsert = useCallback(() => {
    const trimmed = code.trim();
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.getSql();
    const cursor = editor.getCursor();
    const lineStart = current.lastIndexOf("\n", cursor - 1) + 1;
    const lineContent = current.slice(lineStart, cursor);
    const needsNewline = lineContent.trim().length > 0;
    const inserted = (needsNewline ? "\n" : "") + trimmed;
    const next = current.slice(0, cursor) + inserted + current.slice(cursor);
    editor.replaceBody(next);
    editor.setCursor(cursor + inserted.length);
  }, [code, editorRef]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code.trim());
    } catch {
      /* ignore */
    }
  }, [code]);

  return (
    <div className={styles.codeBlock}>
      {applied && (
        <span className={styles.appliedBadge}>Applied</span>
      )}
      <pre className={styles.codeContent}>{code.trimEnd()}</pre>
      <div className={styles.codeActions}>
        {canApply && (
          <>
            <button
              type="button"
              className={styles.codeBtn}
              onClick={handleApply}
              data-testid="btn-apply"
            >
              Apply
            </button>
            <button
              type="button"
              className={styles.codeBtn}
              onClick={handleInsert}
              data-testid="btn-insert"
            >
              Insert
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.codeBtn}
          onClick={() => void handleCopy()}
          data-testid="btn-copy"
        >
          Copy
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolCard sub-component
// ---------------------------------------------------------------------------

interface ToolCardProps {
  tool: ToolUseRecord;
}

/** Pull a string from `obj[key]`, returning null if missing or non-string. */
function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Short final path segment (so "/Users/x/foo/bar.sql" → "bar.sql"). */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Truncate to `max` chars (counting code points imperfectly but fine for tooling). */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/** First non-empty line of multi-line text, with an ellipsis suffix if it had more. */
function firstLinePreview(text: string, max = 120): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const newlineIdx = trimmed.indexOf("\n");
  const hasMore = newlineIdx !== -1;
  const first = hasMore ? trimmed.slice(0, newlineIdx).trimEnd() : trimmed;
  const truncated = truncate(first, max);
  return hasMore && !truncated.endsWith("…") ? truncated + "…" : truncated;
}

/**
 * Derive a tool-specific label + secondary description from the recorded input.
 * Maps Claude Code's tool names (Read, Edit, Write, Bash, Grep, Glob, WebFetch,
 * Task, Skill) to their conventional input fields. Unknown tools fall back to
 * the first plausible string field.
 */
function deriveToolDisplay(tool: ToolUseRecord): { primary: string; secondary: string | null } {
  if (!tool.input || typeof tool.input !== "object" || Array.isArray(tool.input)) {
    return { primary: tool.name, secondary: null };
  }
  const inp = tool.input as Record<string, unknown>;
  const description = strField(inp, "description");

  // Special-case the common tools by exact (capitalised) name.
  switch (tool.name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const fp = strField(inp, "file_path") ?? strField(inp, "path");
      return {
        primary: fp ? `${tool.name} ${basename(fp)}` : tool.name,
        secondary: description,
      };
    }
    case "Bash": {
      const cmd = strField(inp, "command");
      return {
        primary: tool.name,
        secondary: description ?? (cmd ? truncate(cmd, 160) : null),
      };
    }
    case "Grep": {
      const pattern = strField(inp, "pattern");
      const path = strField(inp, "path");
      const where = path ? ` in ${basename(path)}` : "";
      return {
        primary: pattern ? `${tool.name} ${truncate(pattern, 40)}${where}` : tool.name,
        secondary: description,
      };
    }
    case "Glob": {
      const pattern = strField(inp, "pattern");
      return {
        primary: pattern ? `${tool.name} ${truncate(pattern, 60)}` : tool.name,
        secondary: description,
      };
    }
    case "WebFetch":
    case "WebSearch": {
      const url = strField(inp, "url") ?? strField(inp, "query");
      return {
        primary: url ? `${tool.name} ${truncate(url, 60)}` : tool.name,
        secondary: description,
      };
    }
    case "Task":
    case "Agent": {
      const subj = strField(inp, "subagent_type") ?? strField(inp, "agent");
      return {
        primary: subj ? `${tool.name} (${subj})` : tool.name,
        secondary: description ?? strField(inp, "prompt"),
      };
    }
    case "Skill": {
      const skill = strField(inp, "skill") ?? strField(inp, "name");
      return {
        primary: skill ? `${tool.name} ${skill}` : tool.name,
        secondary: description,
      };
    }
    default: {
      // Best-effort: pick a primary identifier-ish field and pair with description.
      const fallback =
        strField(inp, "file_path") ??
        strField(inp, "path") ??
        strField(inp, "url") ??
        strField(inp, "pattern") ??
        strField(inp, "name") ??
        null;
      return {
        primary: fallback ? `${tool.name} ${truncate(fallback, 60)}` : tool.name,
        secondary: description,
      };
    }
  }
}

function ToolCard({ tool }: ToolCardProps) {
  const isFinished = tool.output !== null;
  const { primary, secondary } = deriveToolDisplay(tool);
  const errorPreview =
    isFinished && tool.is_error && tool.output
      ? firstLinePreview(tool.output, 120)
      : null;

  const truncatedOutput = tool.output && tool.output.length > 400
    ? tool.output.slice(0, 400) + "…"
    : tool.output;

  return (
    <details className={styles.toolCard}>
      <summary className={styles.toolCardSummary}>
        <span className={styles.toolCardIcon}>▸</span>
        <div className={styles.toolCardText}>
          <span className={styles.toolCardLabel}>{primary}</span>
          {secondary && (
            <span className={styles.toolCardSecondary}>{secondary}</span>
          )}
          {errorPreview && (
            <span className={styles.toolCardErrorPreview}>{errorPreview}</span>
          )}
        </div>
        {isFinished && (
          <span className={tool.is_error ? styles.toolCardError : styles.toolCardOk}>
            {tool.is_error ? "✗" : "✓"}
          </span>
        )}
      </summary>
      <div className={styles.toolCardBody}>
        {tool.input !== undefined && (
          <pre className={styles.toolCardPre}>
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        )}
        {truncatedOutput && (
          <pre className={styles.toolCardPre}>{truncatedOutput}</pre>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// AssistantTurn sub-component
// ---------------------------------------------------------------------------

interface AssistantTurnProps {
  turn: ChatTurn;
  editorRef: React.RefObject<QueryEditorHandle>;
  isLast: boolean;
  autoAppliedBlock?: number | null; // index of block that was auto-applied
  editorChanged?: boolean;
  onManualApply?: (blockIndex: number) => void;
}

function AssistantTurn({
  turn,
  editorRef,
  isLast,
  autoAppliedBlock,
  editorChanged,
  onManualApply,
}: AssistantTurnProps) {
  const segments = parseSegments(turn.content);
  let codeBlockIndex = 0;

  return (
    <div className={styles.assistantTurn}>
      {/* Tool-call cards rendered above the text */}
      {turn.tool_uses.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}

      {/* Render text and code segments */}
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          return (
            <span key={i} className={styles.turnText}>
              {seg.content}
            </span>
          );
        }
        // code block
        const blockIdx = codeBlockIndex++;
        const isApplied = autoAppliedBlock === blockIdx;
        return (
          <CodeBlock
            key={i}
            code={seg.code}
            lang={seg.lang}
            editorRef={editorRef}
            applied={isApplied}
            onApply={() => onManualApply?.(blockIdx)}
          />
        );
      })}

      {/* Editor-changed notice */}
      {isLast && editorChanged && (
        <p className={styles.editorChangedNotice}>
          Editor changed since this answer — Apply manually if you want to use it.
        </p>
      )}

      {/* Stopped notice for cancelled turns */}
      {turn.content === "" && !isLast && (
        <span className={styles.stoppedBadge}>Stopped</span>
      )}
    </div>
  );
}

// Stable empty snapshot for when there is no session.
import type { ChatSessionSnapshot } from "@/modules/ai/session";
const EMPTY_SNAPSHOT: ChatSessionSnapshot = {
  turns: [],
  state: "idle",
  errorMessage: null,
  pendingStatus: null,
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChatPanel({
  open,
  onClose,
  connectionId,
  contextPath,
  editorRef,
  result = null,
}: ChatPanelProps) {
  // Session stored in state so React can re-subscribe via useSyncExternalStore
  // when the session instance changes (connectionId change).
  const [session, setSession] = useState<ChatSession | null>(null);

  // Provider binding tracking.
  const sessionBoundProvider = useRef<ProviderId | null>(null);

  // Auto-apply state.
  const [autoApply, setAutoApply] = useState(() =>
    localStorage.getItem("argus.ai.autoApply") === "1",
  );

  // Persist auto-apply preference.
  useEffect(() => {
    localStorage.setItem("argus.ai.autoApply", autoApply ? "1" : "0");
  }, [autoApply]);

  // Textarea input.
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Attachment state.
  const [attachments, setAttachments] = useState<AttachedResult[]>([]);
  const canAttach = !!result && result.rows.length > 0;
  const handleAttach = useCallback(() => {
    if (!result || result.rows.length === 0) return;
    setAttachments((prev) => [
      ...prev,
      captureResult(result.columns, result.rows, result.truncated),
    ]);
  }, [result]);
  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Track editor snapshot at turn start for auto-apply detection.
  const editorSnapshotRef = useRef<string | null>(null);

  // Track which block was auto-applied per last assistant turn.
  const [autoAppliedBlock, setAutoAppliedBlock] = useState<number | null>(null);
  const [editorChangedNotice, setEditorChangedNotice] = useState(false);

  // AI settings.
  const { settings } = useAiSettings();
  const currentResolved = useResolvedProviderId(connectionId);

  // Session lifecycle: mint one per (open, connectionId), close on cleanup.
  // Strict-Mode-safe: every effect-run owns the session it creates and closes
  // exactly that one in its cleanup. No external refs to go stale.
  useEffect(() => {
    if (!open) return;
    const next = new ChatSession(connectionId);
    sessionBoundProvider.current = null;
    setSession(next);
    return () => {
      void next.close();
      setSession((prev) => (prev === next ? null : prev));
    };
  }, [open, connectionId]);

  // useSyncExternalStore — subscribe to session state reactively.
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!session) return () => {};
      return session.subscribe(fn);
    },
    [session],
  );

  const getSnapshot = useCallback((): typeof EMPTY_SNAPSHOT => {
    if (!session) return EMPTY_SNAPSHOT;
    return session.getSnapshot();
  }, [session]);

  const chatSnapshot = useSyncExternalStore(subscribe, getSnapshot);

  // Auto-apply on Done.
  const prevTurnCount = useRef(0);
  useEffect(() => {
    const turns = chatSnapshot.turns;
    const state = chatSnapshot.state;
    // Detect transition to idle with more turns than before.
    if (state !== "idle") {
      prevTurnCount.current = turns.length;
      return;
    }
    if (turns.length <= prevTurnCount.current) {
      prevTurnCount.current = turns.length;
      return;
    }
    prevTurnCount.current = turns.length;

    // Find the last assistant turn.
    const lastAssistant = [...turns].reverse().find((t) => t.role === "Assistant");
    if (!lastAssistant || !autoApply) return;

    const segments = parseSegments(lastAssistant.content);
    const sqlBlocks = segments.filter(
      (s): s is { kind: "code"; lang: string | null; code: string } =>
        s.kind === "code" && isSqlLike(s.lang),
    );

    if (sqlBlocks.length !== 1) return;

    const currentSql = editorRef.current?.getSql() ?? "";
    const editorSnapshot = editorSnapshotRef.current;

    if (editorSnapshot !== null && currentSql !== editorSnapshot) {
      // Editor was modified — suppress auto-apply.
      setEditorChangedNotice(true);
      setAutoAppliedBlock(null);
      return;
    }

    // Find block index of the single SQL block (within code blocks only).
    let sqlBlockIdx = 0;
    for (const s of segments) {
      if (s.kind === "code") {
        if (isSqlLike(s.lang)) break;
        sqlBlockIdx++;
      }
    }

    // Apply it.
    const firstSqlBlock = sqlBlocks[0];
    if (!firstSqlBlock) return;
    const sql = firstSqlBlock.code.trim();
    editorRef.current?.replaceBody(sql);
    const len = (editorRef.current?.getSql() ?? "").length;
    editorRef.current?.setCursor(len);
    setAutoAppliedBlock(sqlBlockIdx);
    setEditorChangedNotice(false);
  }, [chatSnapshot.state, chatSnapshot.turns, autoApply, editorRef]);

  // Send handler.
  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || chatSnapshot.state === "streaming") return;
    if (!session) return;

    // Bind provider on first send.
    if (sessionBoundProvider.current === null && currentResolved) {
      sessionBoundProvider.current = currentResolved;
    }

    // Capture editor snapshot for auto-apply comparison.
    editorSnapshotRef.current = editorRef.current?.getSql() ?? null;
    setAutoAppliedBlock(null);
    setEditorChangedNotice(false);

    setInput("");
    void session.send(trimmed, attachments);
    setAttachments([]);
  }, [input, chatSnapshot.state, currentResolved, editorRef, session, attachments]);

  // Re-focus textarea after streaming ends.
  useEffect(() => {
    if (chatSnapshot.state === "idle") {
      textareaRef.current?.focus();
    }
  }, [chatSnapshot.state]);

  // Textarea keyboard handler.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Cancel handler.
  const handleCancel = useCallback(() => {
    void session?.cancel();
  }, [session]);

  // Provider change notice.
  const showProviderChangeNotice =
    sessionBoundProvider.current !== null &&
    currentResolved !== null &&
    currentResolved !== sessionBoundProvider.current;

  // Scroll messages to bottom on new turns.
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatSnapshot.turns]);

  // Context badge.
  const contextLabel = contextPath
    ? contextPath.split("/").filter(Boolean).pop() ?? contextPath
    : "No context folder";
  const contextTooltip = contextPath
    ? contextPath
    : "No context folder — CLI providers will run from the system temp directory; API providers will receive an empty payload.";

  // Provider + model display.
  const displayProvider = sessionBoundProvider.current ?? currentResolved;
  const displayModel = displayProvider
    ? (getModelForProvider(displayProvider, settings) ??
       displayProvider)
    : null;

  if (!open) return null;

  const streaming = chatSnapshot.state === "streaming";
  const sendDisabled = input.trim() === "" || streaming;

  return (
    <aside className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.headerTitle}>✨ AI chat</span>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onClose}
              aria-label="Close AI chat"
            >
              ×
            </button>
          </div>
        </div>

        {displayProvider && (
          <div className={styles.providerLine}>
            {PROVIDER_LABELS[displayProvider]}
            {displayModel ? ` · ${displayModel}` : ""}
          </div>
        )}

        <div
          className={styles.contextBadge}
          title={contextTooltip}
        >
          {contextPath ? "📁 " : ""}
          {contextLabel}
        </div>

        <label className={styles.autoApplyToggle}>
          <input
            type="checkbox"
            checked={autoApply}
            onChange={(e) => setAutoApply(e.target.checked)}
          />
          <span>Auto-apply</span>
        </label>

        {/* Provider change notice */}
        {showProviderChangeNotice && currentResolved && sessionBoundProvider.current && (
          <div className={styles.providerChangeNotice}>
            Settings changed — new chats will use{" "}
            {PROVIDER_LABELS[currentResolved]}. This chat continues with{" "}
            {PROVIDER_LABELS[sessionBoundProvider.current]}.
          </div>
        )}
      </div>

      {/* Messages */}
      <div className={styles.messages} ref={messagesRef}>
        {chatSnapshot.turns.length === 0 && (
          <div className={styles.emptyState}>
            Ask a question about your data…
          </div>
        )}

        {chatSnapshot.turns.map((turn, i) => {
          const isLastTurn = i === chatSnapshot.turns.length - 1;
          if (turn.role === "User") {
            return (
              <div key={i} className={styles.userTurn}>
                {turn.content}
              </div>
            );
          }
          return (
            <AssistantTurn
              key={i}
              turn={turn}
              editorRef={editorRef}
              isLast={isLastTurn}
              autoAppliedBlock={isLastTurn ? autoAppliedBlock : null}
              editorChanged={isLastTurn ? editorChangedNotice : false}
            />
          );
        })}

        {streaming && (
          <div className={styles.workingIndicator} aria-live="polite">
            <span className={styles.workingDot} />
            <span className={styles.workingText}>
              {chatSnapshot.pendingStatus ?? "Working"}
            </span>
            <span className={styles.workingEllipsis} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}

        {chatSnapshot.errorMessage && (
          <div className={styles.errorMessage}>{chatSnapshot.errorMessage}</div>
        )}
      </div>

      {/* Input area */}
      <div className={styles.inputArea}>
        {(attachments.length > 0 || canAttach) && (
          <div className={styles.attachmentBar}>
            {attachments.map((a) => (
              <span key={a.id} className={styles.attachmentChip} data-testid="attachment-chip">
                <span className={styles.attachmentChipLabel}>
                  {a.row_count} row{a.row_count === 1 ? "" : "s"}
                  {a.truncated ? " (truncated)" : ""}
                </span>
                <button
                  type="button"
                  className={styles.attachmentChipRemove}
                  onClick={() => handleRemoveAttachment(a.id)}
                  aria-label="Remove attachment"
                  data-testid="attachment-remove"
                >
                  ×
                </button>
              </span>
            ))}
            {canAttach && result && (
              <button
                type="button"
                className={styles.attachBtn}
                onClick={handleAttach}
                data-testid="btn-attach-result"
              >
                + Attach result ({result.rows.length} row{result.rows.length === 1 ? "" : "s"})
              </button>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything…"
          rows={3}
          disabled={streaming}
          aria-label="Chat input"
        />
        <div className={styles.inputRow}>
          {streaming ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnStop}`}
              onClick={handleCancel}
              data-testid="btn-stop"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={sendDisabled}
              onClick={handleSend}
              data-testid="btn-send"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
