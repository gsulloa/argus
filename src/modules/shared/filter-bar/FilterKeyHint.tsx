import styles from "./FilterKeyHint.module.css";

// Memoized at module scope — no hook needed, platform doesn't change at runtime.
const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/i.test(
    (navigator as Navigator & { platform?: string }).platform || navigator.userAgent,
  );

// Replace ⌘ with Ctrl on non-Mac platforms; all other glyphs pass through unchanged.
function toPlatformGlyph(key: string): string {
  if (isMac) return key;
  return key.replace("⌘", "Ctrl");
}

export interface FilterKeyHintProps {
  keys: string | string[];
  className?: string;
}

export function FilterKeyHint({ keys, className }: FilterKeyHintProps) {
  // Normalise to array so both string and string[] inputs render as chips.
  const chips = Array.isArray(keys) ? keys : [keys];

  return (
    <>
      {chips.map((k, i) => (
        <kbd
          key={i}
          className={[styles.hint, className].filter(Boolean).join(" ")}
        >
          {toPlatformGlyph(k)}
        </kbd>
      ))}
    </>
  );
}

export default FilterKeyHint;
