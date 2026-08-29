import "@testing-library/jest-dom/vitest";

// ---------------------------------------------------------------------------
// jsdom gaps
//
// jsdom implements neither `ResizeObserver` nor `Element.prototype.scrollIntoView`.
// The tab strip's overflow measurement (`useTabOverflow`) uses both, so stub them
// here rather than branching on `typeof ResizeObserver` in production code — that
// way the app and the tests take the same path.
//
// Both are installed only when absent, so a future jsdom that ships real
// implementations wins.
// ---------------------------------------------------------------------------

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}

if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
