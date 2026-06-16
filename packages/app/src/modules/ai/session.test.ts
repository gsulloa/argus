import { describe, it, expect, vi, beforeEach } from "vitest";

// Polyfill rAF/cAF for jsdom (which may lack them or use fake timers).
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(cb, 0) as unknown as number;
globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);

// Polyfill crypto.randomUUID if absent in jsdom.
if (!("randomUUID" in globalThis.crypto)) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => "00000000-0000-0000-0000-000000000000",
  });
}

const { mockListen, mockChatSend, mockChatCancel, mockChatClose } = vi.hoisted(() => ({
  mockListen: vi.fn(),
  mockChatSend: vi.fn(),
  mockChatCancel: vi.fn(),
  mockChatClose: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("./api", () => ({
  aiApi: {
    chatSend: (...args: unknown[]) => mockChatSend(...args),
    chatCancel: (...args: unknown[]) => mockChatCancel(...args),
    chatClose: (...args: unknown[]) => mockChatClose(...args),
  },
}));

import { ChatSession } from "./session";
import type { ChatDelta } from "./types";

describe("ChatSession", () => {
  let session: ChatSession;
  let triggerEvent: ((delta: ChatDelta) => void) | null = null;

  beforeEach(() => {
    triggerEvent = null;
    mockListen.mockReset();
    mockChatSend.mockReset().mockResolvedValue(undefined);
    mockChatCancel.mockReset().mockResolvedValue(undefined);
    mockChatClose.mockReset().mockResolvedValue(undefined);
    mockListen.mockImplementation(
      async (_channel: string, handler: (e: { payload: ChatDelta }) => void) => {
        triggerEvent = (delta) => handler({ payload: delta });
        return () => {
          triggerEvent = null;
        };
      },
    );
    session = new ChatSession("conn-123");
  });

  /** Flush microtasks and rAF timeout in jsdom. */
  async function flush() {
    await new Promise((r) => setTimeout(r, 10));
  }

  it("appends User and Assistant placeholder on send", async () => {
    void session.send("hi");
    await flush();
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toMatchObject({ role: "User", content: "hi", tool_uses: [] });
    expect(session.turns[1]).toMatchObject({ role: "Assistant", content: "", tool_uses: [] });
    expect(session.state).toBe("streaming");
  });

  it("appends Text deltas to the assistant turn", async () => {
    void session.send("hi");
    await flush();
    triggerEvent!({ kind: "Text", data: "Hello" });
    triggerEvent!({ kind: "Text", data: " world" });
    await flush(); // rAF fires
    expect(session.turns[1]?.content).toBe("Hello world");
  });

  it("finalises on Done", async () => {
    const promise = session.send("hi");
    await flush();
    triggerEvent!({ kind: "Text", data: "response" });
    triggerEvent!({ kind: "Done", data: { finish_reason: null } });
    await promise;
    expect(session.state).toBe("idle");
    expect(session.turns[1]?.content).toBe("response");
  });

  it("finalises on Done with finish_reason", async () => {
    const promise = session.send("hi");
    await flush();
    triggerEvent!({ kind: "Done", data: { finish_reason: "end_turn" } });
    await promise;
    expect(session.state).toBe("idle");
  });

  it("finalises on Error and rejects pendingTurn", async () => {
    const promise = session.send("hi");
    await flush();
    triggerEvent!({ kind: "Error", data: "something went wrong" });
    await expect(promise).rejects.toThrow("something went wrong");
    expect(session.state).toBe("error");
    expect(session.errorMessage).toBe("something went wrong");
  });

  it("handles ToolCallStarted — appends to assistant tool_uses", async () => {
    void session.send("hi");
    await flush();
    triggerEvent!({
      kind: "ToolCallStarted",
      data: { id: "tool-1", name: "run_query", input: { sql: "SELECT 1" } },
    });
    await flush();
    const assistantTurn = session.turns[1]!;
    expect(assistantTurn.tool_uses).toHaveLength(1);
    expect(assistantTurn.tool_uses[0]).toMatchObject({
      id: "tool-1",
      name: "run_query",
      input: { sql: "SELECT 1" },
      output: null,
      is_error: false,
    });
  });

  it("handles ToolCallFinished — updates existing tool_use", async () => {
    void session.send("hi");
    await flush();
    triggerEvent!({
      kind: "ToolCallStarted",
      data: { id: "tool-1", name: "run_query", input: { sql: "SELECT 1" } },
    });
    triggerEvent!({
      kind: "ToolCallFinished",
      data: { id: "tool-1", output: "1 row", is_error: false },
    });
    await flush();
    const assistantTurn = session.turns[1]!;
    expect(assistantTurn.tool_uses[0]).toMatchObject({
      id: "tool-1",
      output: "1 row",
      is_error: false,
    });
  });

  it("Status deltas are ignored in turns array", async () => {
    void session.send("hi");
    await flush();
    triggerEvent!({ kind: "Status", data: "Thinking..." });
    await flush();
    // turns stays at 2 (User + Assistant), Status not added
    expect(session.turns).toHaveLength(2);
  });

  it("notifies subscribers on state changes", async () => {
    const notify = vi.fn();
    const unsub = session.subscribe(notify);
    void session.send("hi");
    await flush();
    // Initial send notifies (User turn, streaming state).
    expect(notify).toHaveBeenCalled();
    unsub();
  });

  it("unsubscribe removes listener", async () => {
    const notify = vi.fn();
    const unsub = session.subscribe(notify);
    unsub();
    void session.send("hi");
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it("getSnapshot returns current state", () => {
    const snap = session.getSnapshot();
    expect(snap).toEqual({ turns: [], state: "idle", errorMessage: null, pendingStatus: null });
  });

  it("cancel calls chatCancel with sessionId", async () => {
    void session.send("hi");
    await flush();
    await session.cancel();
    expect(mockChatCancel).toHaveBeenCalledWith(session.sessionId);
  });

  it("close unlistens and calls chatClose", async () => {
    void session.send("hi");
    await flush();
    expect(triggerEvent).not.toBeNull();
    await session.close();
    expect(triggerEvent).toBeNull(); // unlisten fired
    expect(mockChatClose).toHaveBeenCalledWith(session.sessionId);
  });

  it("re-uses the same unlisten across multiple sends", async () => {
    const promise1 = session.send("first");
    await flush();
    triggerEvent!({ kind: "Done", data: { finish_reason: null } });
    await promise1;

    const listenCallCount = mockListen.mock.calls.length;

    const promise2 = session.send("second");
    await flush();
    triggerEvent!({ kind: "Done", data: { finish_reason: null } });
    await promise2;

    // listen() should only have been called once (first send).
    expect(mockListen.mock.calls.length).toBe(listenCallCount);
  });

  it("handles chatSend rejection by setting error state", async () => {
    mockChatSend.mockRejectedValueOnce(new Error("network error"));
    await expect(session.send("hi")).rejects.toThrow("network error");
    expect(session.state).toBe("error");
    expect(session.errorMessage).toBe("network error");
  });
});
