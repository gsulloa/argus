/**
 * Returns true when `el` is a surface the user is actively typing into:
 * an `<input>`, `<textarea>`, `<select>`, any element with
 * `isContentEditable === true`, or a descendant of a CodeMirror editor
 * (`.cm-editor`). Returns `false` for `null`.
 *
 * This predicate is duplicated ad-hoc in roughly nine places across the
 * codebase — `useShortcuts.ts`, `useCommandHotkeys.ts`, `useSaveShortcut.ts`,
 * the three `TableViewerTab.tsx` files (postgres, mysql, mssql),
 * `FilterBar.tsx`, `EventsTab.tsx`, and `dynamo/data-view/DataViewTab.tsx`.
 * Those call sites are deliberately NOT retrofitted to use this helper: each
 * one's guard differs subtly (some intentionally omit the `.cm-editor`
 * check), and swapping them all in wholesale would risk unrelated shortcut
 * regressions riding along with an unrelated change. Do not modify any of
 * those existing files when reusing this helper — introduce new call sites
 * only.
 */
export function isTextEntryTarget(el: Element | null): boolean {
  if (el === null) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.closest(".cm-editor") !== null;
}
