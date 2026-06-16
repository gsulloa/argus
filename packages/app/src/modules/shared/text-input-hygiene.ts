import { EditorView } from "@codemirror/view";

/**
 * Argus is a database client: text-editing surfaces carry identifiers, SQL,
 * JSON, and raw column values where any silent mutation by the OS/browser is a
 * correctness bug. Spread these props onto every native `<input>` / `<textarea>`
 * to disable auto-capitalize, autocorrect, autocomplete, and spellcheck.
 *
 * Usage: `<input {...noAutoCorrectProps} ... />`
 */
export const noAutoCorrectProps = {
  autoCapitalize: "off",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
} as const;

/**
 * CodeMirror 6 renders its editable region to an internal `contentEditable`
 * div that is not reachable through React props. Add this extension to an
 * editor's `extensions` array to disable the same text-mutation features on
 * that surface via HTML attributes (note: string values, lower-case names).
 *
 * Usage: include `noAutoCorrectEditorAttrs` in `EditorState.create({ extensions: [...] })`.
 */
export const noAutoCorrectEditorAttrs = EditorView.contentAttributes.of({
  autocapitalize: "off",
  autocorrect: "off",
  autocomplete: "off",
  spellcheck: "false",
});
