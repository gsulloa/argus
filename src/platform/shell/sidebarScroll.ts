import { createContext, useContext, type RefObject } from "react";

export const SidebarScrollContext = createContext<RefObject<HTMLElement> | null>(null);

export function useSidebarScrollRef(): RefObject<HTMLElement> | null {
  return useContext(SidebarScrollContext);
}
