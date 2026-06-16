import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "@/platform/toast";
import { connectionsApi } from "@/platform/connection-registry/api";
import type { AppError } from "@/platform/errors/AppError";
import { classifyDynamoError, extractSsoCommand } from "./errors";
import { useDynamoForm } from "./FormController";

/**
 * §10.1 + §10.3: Hook that returns an error handler for Dynamo errors.
 *
 * - session_expired (access_keys with session token) → open credentials-only form + toast
 * - sso_expired → toast with copy-command text; do NOT open credentials-only form
 * - other → generic toast
 */
export function useDynamoErrorHandler() {
  const toast = useToast();
  const form = useDynamoForm();

  return useCallback(
    async (connectionId: string, err: AppError) => {
      const category = classifyDynamoError(err);

      if (category === "session_expired") {
        // §10.1: open form in credentials-only sub-mode
        try {
          const list = await connectionsApi.list();
          const conn = list.find((c) => c.id === connectionId);
          if (conn) {
            form.openCredentialsOnly(conn);
          }
        } catch {
          // swallow — best effort
        }
        toast.show("Session token expired — re-enter credentials", "error");
      } else if (category === "sso_expired") {
        // §10.3: toast with command; do NOT open form
        const cmd = extractSsoCommand(err) ?? "aws sso login --profile <profile>";
        toast.show(`SSO session expired. Run: ${cmd}`, "error");
      } else {
        // generic error
        const code =
          err.kind === "Aws" ? (err.aws?.code ?? "Error") : err.kind;
        const message =
          err.kind === "Aws"
            ? (err.aws?.message ?? "")
            : (err.message ?? "Unknown error");
        toast.show(`${code}: ${message}`, "error");
      }
    },
    [toast, form],
  );
}

/**
 * §10.2: Listens for dynamo:credentials-refreshed backend events and re-dispatches
 * them as synthetic window events so DynamoDB tabs can clear their "Reconnecting…" overlays.
 *
 * Mount this component once at the app root.
 */
export function CredentialsRefreshedListener() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<{ id: string }>("dynamo:credentials-refreshed", (event) => {
      window.dispatchEvent(
        new CustomEvent("dynamo:credentials-refreshed:ui", {
          detail: event.payload,
        }),
      );
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      })
      .catch(() => {
        // tauri event listen failed — non-fatal
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return null;
}
