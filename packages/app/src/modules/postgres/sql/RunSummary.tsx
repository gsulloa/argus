import { useEffect, useState } from "react";

interface Props {
  /** The post-completion summary text (e.g. `5 rows · 12 ms`), or null when idle. */
  staticSummary: string | null;
  /** Date.now() at which the in-flight run started, or null when not running. */
  runStartedAt: number | null;
  isRunning: boolean;
}

const TICK_MS = 100;

export function RunSummary({ staticSummary, runStartedAt, isRunning }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning || runStartedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [isRunning, runStartedAt]);

  if (isRunning && runStartedAt !== null) {
    return <>{formatElapsed(now - runStartedAt)}</>;
  }
  if (!staticSummary) return null;
  return <>{staticSummary}</>;
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return "Running…";
  if (ms < 60_000) {
    return `Running… ${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `Running… ${m}:${String(s).padStart(2, "0")}`;
}
