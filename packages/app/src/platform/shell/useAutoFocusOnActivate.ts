import { useEffect, useRef, type RefObject } from "react";
import { isTextEntryTarget } from "./focusTargets";

export interface AutoFocusOnActivateOptions {
  /** The tab's `active` prop — true when this is the focused tab. */
  active: boolean;
  /** Tab root element (carries tabIndex={-1}); the fallback focus target. */
  rootRef: RefObject<HTMLElement | null>;
  /** Preferred focus target — the data grid's imperative handle. */
  targetRef: RefObject<{ focus(): void } | null>;
}

/**
 * Moves DOM focus into a table viewer tab when it activates, so
 * viewer-scoped shortcuts (⌘F / ⌘R / ⌘Z / ⌘1-4 and the grid's own key
 * handling) work from the first keystroke instead of requiring a priming
 * click. Fixes issue #280: opening or switching to a tab never used to
 * touch `document.activeElement`, leaving it on `document.body` (or
 * wherever the schema tree / quick switcher last left it).
 *
 * Fires once per activation, on the `false → true` edge of `active` — which
 * includes first mount when `active` is already `true`, the common "open a
 * table" path, since tabs mount already-active. Never fires on `true →
 * false`, and never re-fires on a re-render while `active` stays `true`.
 *
 * The actual focus call is scheduled via `requestAnimationFrame` so it runs
 * post-paint, once the grid has had a chance to mount; the pending frame is
 * cancelled on cleanup so a fast tab switch can't land a stale focus. The
 * no-steal guards (already-focused-inside, text-entry-target) are re-checked
 * *inside* the RAF callback rather than before scheduling, because the DOM
 * can change during that gap (e.g. the user clicks somewhere first).
 *
 * Focus target resolution prefers the grid — `targetRef.current?.focus()` —
 * since that is what makes ⌘C / ⌘A / the grid's key handling work; it then
 * falls back to the tab root (`rootRef.current?.focus()`) whenever focus did
 * not actually land inside the tab. The fallback is driven by *observed*
 * focus, not by whether the handle is null, because the three viewers hide
 * the grid in different ways: MySQL unmounts it on a non-Data subtab, while
 * Postgres and MSSQL keep it mounted under `display: none` — and focusing a
 * display:none element is a silent no-op. Verifying covers unmounted,
 * hidden, and detached alike.
 *
 * This is non-destructive: it only moves focus and never touches selection
 * state (no active cell, no row-range selection), so destructive shortcuts
 * (⌘V, Backspace/Delete bulk-delete) stay armed only against a selection the
 * user actually made.
 */
export function useAutoFocusOnActivate({
  active,
  rootRef,
  targetRef,
}: AutoFocusOnActivateOptions): void {
  const prevActiveRef = useRef(false);

  useEffect(() => {
    const prevActive = prevActiveRef.current;
    prevActiveRef.current = active;

    if (!active || prevActive) return;

    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (root?.contains(document.activeElement)) return;
      if (isTextEntryTarget(document.activeElement)) return;
      // Try the grid first, then *verify* rather than assume. A non-null
      // handle does not mean the grid is focusable: the Postgres and MSSQL
      // viewers keep the grid mounted but `display: none` while a non-Data
      // subtab is showing, and `focus()` on a descendant of a display:none
      // subtree is a silent no-op. Falling through to the tab root whenever
      // focus did not actually land keeps every not-focusable case — grid
      // unmounted, hidden, or detached — on one code path.
      targetRef.current?.focus();
      if (!root?.contains(document.activeElement)) root?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [active, rootRef, targetRef]);
}
