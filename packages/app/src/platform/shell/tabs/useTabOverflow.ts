import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Tab } from "./types";
import { computeHiddenTabIds, type TabMetric } from "./tabOverflow";

/**
 * Measures which tabs are not fully visible in the tab strip's scrollport.
 *
 * All the decision logic lives in `computeHiddenTabIds`; this hook only wires
 * DOM events to it:
 *
 * - a passive `scroll` listener on the scroller,
 * - a `ResizeObserver` on the scroller (window / sidebar / inspector resizes),
 * - a layout effect keyed on `tabs` (open, close, reorder, title change).
 *
 * Recomputes are coalesced into a single `requestAnimationFrame`, and state is
 * only written when the hidden-id list actually changes — otherwise every
 * scroll frame would re-render the whole strip.
 */
export function useTabOverflow(tabs: Tab[]) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabEls = useRef(new Map<string, HTMLElement>());
  const frame = useRef<number | null>(null);
  const pending = useRef(false);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  // `tabs` is read inside the rAF callback, which outlives the render that
  // scheduled it. Keep a ref so the callback always measures the current set
  // without having to be re-created (and re-subscribed) on every change.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /**
   * Per-tab ref callback: stores the element, drops it on unmount.
   *
   * The callback is cached per id so its identity is stable across renders —
   * a fresh function each render would make React detach and re-attach every
   * tab ref on every render.
   */
  const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const registerTab = useCallback((id: string) => {
    const cached = refCallbacks.current.get(id);
    if (cached) return cached;
    const cb = (el: HTMLElement | null) => {
      if (el) {
        tabEls.current.set(id, el);
      } else {
        tabEls.current.delete(id);
        refCallbacks.current.delete(id);
      }
    };
    refCallbacks.current.set(id, cb);
    return cb;
  }, []);

  /**
   * Scroll a tab fully into view by the minimum distance required.
   * `inline: "nearest"` means an already-visible tab does not move at all.
   */
  const scrollTabIntoView = useCallback((id: string) => {
    tabEls.current.get(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // Walk `tabs` (not the Map) so metrics come out in tab order. Tabs whose
    // element has not mounted yet are skipped rather than guessed at.
    const metrics: TabMetric[] = [];
    for (const tab of tabsRef.current) {
      const el = tabEls.current.get(tab.id);
      if (!el) continue;
      metrics.push({ id: tab.id, offsetLeft: el.offsetLeft, width: el.offsetWidth });
    }

    const next = computeHiddenTabIds(
      { scrollLeft: scroller.scrollLeft, clientWidth: scroller.clientWidth },
      metrics,
    );

    setHiddenIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i])
        ? prev
        : next,
    );
  }, []);

  /** Coalesce bursts of scroll/resize events into one measurement per frame. */
  const scheduleMeasure = useCallback(() => {
    // The `pending` flag — rather than `frame.current` — is what guards against
    // double-scheduling, and it is set *before* the frame is requested. That
    // keeps the guard correct even if `requestAnimationFrame` runs its callback
    // synchronously, where `frame.current` would be assigned only after the
    // callback had already cleared it.
    if (pending.current) return;
    pending.current = true;
    frame.current = requestAnimationFrame(() => {
      pending.current = false;
      frame.current = null;
      measure();
    });
  }, [measure]);

  // Subscribe to scroll + resize for the lifetime of the scroller element.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(scroller);

    return () => {
      scroller.removeEventListener("scroll", scheduleMeasure);
      ro.disconnect();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      pending.current = false;
    };
  }, [scheduleMeasure]);

  // Re-measure synchronously after any change to the tab set, so the overflow
  // button appears in the same paint as the tab that pushed the strip over.
  useLayoutEffect(() => {
    measure();
  }, [tabs, measure]);

  return { scrollerRef, registerTab, scrollTabIntoView, hiddenIds };
}
