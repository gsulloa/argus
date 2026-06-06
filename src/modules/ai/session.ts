/**
 * ChatSession — frontend session manager for the AI chat panel.
 *
 * Wire shape (adjacently tagged, see types.ts for full docs):
 *   Text(String)   → { "kind": "Text", "data": "hello" }
 *   Status(String) → { "kind": "Status", "data": "..." }
 *   Error(String)  → { "kind": "Error", "data": "..." }
 *   Struct variants → { "kind": "ToolCallStarted", "data": { id, name, input } }
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiApi } from "./api";
import type { AttachedResult, ChatDelta, ChatRole, ChatTurn, ToolUseRecord } from "./types";

// Suppress TS unused warning — ChatRole is used as a type in the interface.
void (undefined as unknown as ChatRole);

export type ChatSessionState = "idle" | "streaming" | "error";

export interface ChatSessionSnapshot {
  turns: ChatTurn[];
  state: ChatSessionState;
  errorMessage: string | null;
  /** Latest transient status message from the provider, cleared on Done/Error. */
  pendingStatus: string | null;
}

export class ChatSession {
  readonly sessionId: string;
  readonly connectionId: string | null;
  turns: ChatTurn[] = [];
  state: ChatSessionState = "idle";
  errorMessage: string | null = null;
  pendingStatus: string | null = null;

  /** Tool calls currently in flight, keyed by tool_use id. */
  private pendingTools: Map<string, ToolUseRecord> = new Map();
  /** Buffer for batching Text deltas via rAF. */
  private textBuffer: string = "";
  private rafId: number | null = null;
  private unlisten: UnlistenFn | null = null;
  private listeners: Set<() => void> = new Set();
  /** Resolve/reject when the latest send() stream completes (Done or Error). */
  private pendingTurn: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /**
   * Cached snapshot for useSyncExternalStore. The reference is stable between
   * notifications — returning a fresh object on every getSnapshot() call would
   * make React detect infinite "store changes" and crash with "Maximum update
   * depth exceeded".
   */
  private snapshot: ChatSessionSnapshot;

  constructor(connectionId: string | null) {
    this.sessionId = crypto.randomUUID();
    this.connectionId = connectionId;
    this.snapshot = {
      turns: this.turns,
      state: this.state,
      errorMessage: this.errorMessage,
      pendingStatus: this.pendingStatus,
    };
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * Compatible with React useSyncExternalStore.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Stable snapshot getter for useSyncExternalStore. */
  getSnapshot = (): ChatSessionSnapshot => this.snapshot;

  private notify() {
    this.snapshot = {
      turns: this.turns,
      state: this.state,
      errorMessage: this.errorMessage,
      pendingStatus: this.pendingStatus,
    };
    for (const fn of this.listeners) fn();
  }

  /**
   * Send a prompt. Appends User + empty Assistant placeholder turns immediately,
   * subscribes to the backend event channel, then resolves when Done or rejects
   * on Error.
   */
  async send(prompt: string, attachedResults: AttachedResult[] = []): Promise<void> {
    // Append User turn locally.
    this.turns = [...this.turns, { role: "User", content: prompt, tool_uses: [] }];
    // Append empty Assistant placeholder.
    this.turns = [...this.turns, { role: "Assistant", content: "", tool_uses: [] }];
    this.state = "streaming";
    this.errorMessage = null;
    this.pendingStatus = null;
    this.notify();

    // Subscribe to the event channel for this session if not already.
    if (!this.unlisten) {
      this.unlisten = await listen<ChatDelta>(
        `ai-chat-delta:${this.sessionId}`,
        (event) => {
          this.handleDelta(event.payload);
        },
      );
    }

    const turnPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };
    });

    try {
      await aiApi.chatSend({
        sessionId: this.sessionId,
        prompt,
        connectionId: this.connectionId,
        attachedResults,
      });
    } catch (e) {
      this.state = "error";
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.pendingTurn = null;
      this.notify();
      throw e;
    }

    return turnPromise;
  }

  private handleDelta(delta: ChatDelta) {
    switch (delta.kind) {
      case "Text":
        this.bufferText(delta.data);
        break;

      case "ToolCallStarted": {
        const lastIdx = this.turns.length - 1;
        const last = this.turns[lastIdx];
        if (last && last.role === "Assistant") {
          const record: ToolUseRecord = {
            id: delta.data.id,
            name: delta.data.name,
            input: delta.data.input,
            output: null,
            is_error: false,
          };
          this.pendingTools.set(delta.data.id, record);
          this.turns = [
            ...this.turns.slice(0, lastIdx),
            { ...last, tool_uses: [...last.tool_uses, record] },
          ];
          this.notify();
        }
        break;
      }

      case "ToolCallFinished": {
        const lastIdx = this.turns.length - 1;
        const last = this.turns[lastIdx];
        if (last && last.role === "Assistant") {
          this.turns = [
            ...this.turns.slice(0, lastIdx),
            {
              ...last,
              tool_uses: last.tool_uses.map((t) =>
                t.id === delta.data.id
                  ? { ...t, output: delta.data.output, is_error: delta.data.is_error }
                  : t,
              ),
            },
          ];
          this.notify();
        }
        break;
      }

      case "Status":
        // Transient status — replaces the previous one (not stacked).
        // Surfaced inline by ChatPanel as a faint live annotation.
        this.pendingStatus = delta.data;
        this.notify();
        break;

      case "Done":
        this.flushText();
        this.state = "idle";
        this.pendingStatus = null;
        this.pendingTurn?.resolve();
        this.pendingTurn = null;
        this.notify();
        break;

      case "Error":
        this.flushText();
        this.state = "error";
        this.errorMessage = delta.data;
        this.pendingStatus = null;
        this.pendingTurn?.reject(new Error(delta.data));
        this.pendingTurn = null;
        this.notify();
        break;
    }
  }

  /**
   * Buffer a text chunk and flush on the next animation frame.
   * Coalesces rapid small text events from CLI providers to avoid
   * triggering React re-renders on every keystroke equivalent.
   */
  private bufferText(text: string) {
    this.textBuffer += text;
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flushText();
    });
  }

  private flushText() {
    if (this.textBuffer.length === 0) return;
    const lastIdx = this.turns.length - 1;
    const last = this.turns[lastIdx];
    if (last && last.role === "Assistant") {
      this.turns = [
        ...this.turns.slice(0, lastIdx),
        { ...last, content: last.content + this.textBuffer },
      ];
    }
    this.textBuffer = "";
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.notify();
  }

  /** Cancel the in-flight request. The backend will emit Error("cancelled"). */
  async cancel(): Promise<void> {
    try {
      await aiApi.chatCancel(this.sessionId);
    } catch {
      /* ignore — session may already be gone */
    }
  }

  /**
   * Unsubscribe from events and free backend session resources.
   * Call when the owning component unmounts.
   */
  async close(): Promise<void> {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      await aiApi.chatClose(this.sessionId);
    } catch {
      /* ignore */
    }
  }
}
