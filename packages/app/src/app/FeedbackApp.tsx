/**
 * FeedbackApp — root component for the `feedback` window.
 *
 * Reads the intent from Rust (via `feedback_intent`) on mount and
 * listens for `feedback:intent-changed` events. Renders FeedbackDialog
 * in window mode (no Radix overlay, fills the whole window).
 *
 * On success → emits `argus:feedback:submitted` and closes the window.
 * On cancel → closes the window.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProviders } from "./AppProviders";
import { FeedbackDialog } from "@/platform/feedback/FeedbackDialog";

interface FeedbackIntent {
  engine: string | null;
}

function FeedbackWindow() {
  const [intent, setIntent] = useState<FeedbackIntent | null>(null);

  useEffect(() => {
    document.title = "Send feedback";

    void invoke<FeedbackIntent>("feedback_intent").then((i) => {
      setIntent(i);
    });

    const unlistenPromise = listen<FeedbackIntent>(
      "feedback:intent-changed",
      (e) => setIntent(e.payload),
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const engine = intent?.engine ?? null;

  return (
    <FeedbackDialog
      open
      engine={engine}
      onOpenChange={(o) => {
        if (!o) void getCurrentWindow().close();
      }}
      onSubmitted={() => {
        void emit("argus:feedback:submitted");
      }}
    />
  );
}

export function FeedbackApp() {
  return (
    <AppProviders>
      <FeedbackWindow />
    </AppProviders>
  );
}
