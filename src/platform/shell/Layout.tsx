import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import styles from "./Layout.module.css";
import { useSetting } from "@/platform/settings/useSetting";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const INSPECTOR_MIN = 220;
const INSPECTOR_MAX = 600;

type LayoutCtx = {
  inspectorOpen: boolean;
  toggleInspector: () => void;
  setInspectorOpen: (v: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  inspectorWidth: number;
  setInspectorWidth: (w: number) => void;
};

const Ctx = createContext<LayoutCtx | null>(null);

export function useLayout() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLayout must be used inside LayoutProvider");
  return v;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function Layout(props: {
  sidebar: ReactNode;
  inspector: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useSetting<number>("layout.sidebar_width", 240);
  const [inspectorWidth, setInspectorWidth] = useSetting<number>("layout.inspector_width", 320);
  const [inspectorOpen, setInspectorOpenRaw] = useSetting<boolean>("layout.inspector_open", false);

  const setInspectorOpen = useCallback(
    (v: boolean) => setInspectorOpenRaw(v),
    [setInspectorOpenRaw],
  );
  const toggleInspector = useCallback(
    () => setInspectorOpenRaw((prev) => !prev),
    [setInspectorOpenRaw],
  );

  const ctxValue = useMemo<LayoutCtx>(
    () => ({
      inspectorOpen,
      toggleInspector,
      setInspectorOpen,
      sidebarWidth,
      setSidebarWidth,
      inspectorWidth,
      setInspectorWidth,
    }),
    [
      inspectorOpen,
      toggleInspector,
      setInspectorOpen,
      sidebarWidth,
      setSidebarWidth,
      inspectorWidth,
      setInspectorWidth,
    ],
  );

  const onSidebarHandlePointerDown = useDragHandle((dx, start) => {
    setSidebarWidth(clamp(start + dx, SIDEBAR_MIN, SIDEBAR_MAX));
  }, sidebarWidth);

  const onInspectorHandlePointerDown = useDragHandle((dx, start) => {
    setInspectorWidth(clamp(start - dx, INSPECTOR_MIN, INSPECTOR_MAX));
  }, inspectorWidth);

  const style = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--inspector-width": `${inspectorWidth}px`,
  } as React.CSSProperties;

  return (
    <Ctx.Provider value={ctxValue}>
      <div className={styles.root} data-inspector={inspectorOpen ? "open" : "closed"} style={style}>
        <aside className={styles.sidebar}>{props.sidebar}</aside>
        <button
          aria-label="Resize sidebar"
          className={styles.sidebarHandle}
          onPointerDown={onSidebarHandlePointerDown}
        />
        <main className={styles.center}>{props.children}</main>
        <button
          aria-label="Resize inspector"
          className={styles.inspectorHandle}
          onPointerDown={onInspectorHandlePointerDown}
        />
        <aside className={styles.inspector}>{props.inspector}</aside>
        <footer className={styles.statusbar}>{props.statusBar}</footer>
      </div>
    </Ctx.Provider>
  );
}

function useDragHandle(onMove: (dx: number, startValue: number) => void, startValue: number) {
  const startValueRef = useRef(startValue);
  startValueRef.current = startValue;

  return useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = startValueRef.current;
      const onMoveEv = (m: PointerEvent) => onMove(m.clientX - startX, start);
      const onUp = () => {
        window.removeEventListener("pointermove", onMoveEv);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMoveEv);
      window.addEventListener("pointerup", onUp);
    },
    [onMove],
  );
}

// Helper for layout-aware components that want to react to inspector width changes
// without owning the state.
export function useInspectorVisible() {
  const { inspectorOpen } = useLayout();
  useEffect(() => {
    document.documentElement.dataset.inspectorOpen = String(inspectorOpen);
  }, [inspectorOpen]);
}
