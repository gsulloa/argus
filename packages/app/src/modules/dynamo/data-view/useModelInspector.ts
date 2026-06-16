/**
 * useModelInspector — manages one AI model inspection run.
 *
 * Subscribes to the `ai-inspect-delta:<sessionId>` Tauri event channel
 * before invoking the `ai_inspect_models` command, matching the lifecycle
 * pattern from src/modules/ai/session.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inspectModels } from "./api";
import type { InspectedModel, InspectDelta } from "./types";

export interface InspectorState {
  status: "idle" | "running" | "done" | "error";
  statusMessage: string | null;
  proposals: InspectedModel[];
  error: string | null;
  start(): Promise<void>;
  reset(): void;
  removeProposal(name: string): void;
}

export function useModelInspector(
  connectionId: string,
  tableName: string,
): InspectorState {
  const [status, setStatus] = useState<InspectorState["status"]>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [proposals, setProposals] = useState<InspectedModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Track unlisten fn so we can clean up on unmount or reset.
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // Stable sessionId per run — regenerated in start()
  const sessionIdRef = useRef<string>(`inspect-${connectionId}-${tableName}-${Date.now()}`);

  function cleanup() {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setStatus("idle");
    setStatusMessage(null);
    setProposals([]);
    setError(null);
  }, []);

  const removeProposal = useCallback((name: string) => {
    setProposals((prev) => prev.filter((p) => p.name !== name));
  }, []);

  const start = useCallback(async () => {
    // Clean up any existing listener from a prior run
    cleanup();

    // Generate a fresh session id for this run
    const sessionId = `inspect-${connectionId}-${tableName}-${Date.now()}`;
    sessionIdRef.current = sessionId;

    setStatus("running");
    setStatusMessage(null);
    setProposals([]);
    setError(null);

    const channel = `ai-inspect-delta:${sessionId}`;

    // Subscribe BEFORE invoking the command (mirror session.ts pattern)
    const unlisten = await listen<InspectDelta>(channel, (event) => {
      const delta = event.payload;
      switch (delta.kind) {
        case "Status":
          setStatusMessage(delta.data);
          break;
        case "Proposals":
          setProposals(delta.data);
          break;
        case "Done":
          setStatus("done");
          setStatusMessage(null);
          cleanup();
          break;
        case "Error":
          setError(delta.data);
          setStatus("error");
          cleanup();
          break;
      }
    });

    unlistenRef.current = unlisten;

    try {
      await inspectModels(sessionId, connectionId, tableName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
      cleanup();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tableName]);

  return { status, statusMessage, proposals, error, start, reset, removeProposal };
}
