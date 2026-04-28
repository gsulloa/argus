import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface PaletteCtx {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

const Ctx = createContext<PaletteCtx | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const value = useMemo<PaletteCtx>(
    () => ({ open, show, hide, toggle }),
    [open, show, hide, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePalette() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePalette must be used inside PaletteProvider");
  return v;
}
