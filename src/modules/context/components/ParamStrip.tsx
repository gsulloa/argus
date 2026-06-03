import type { QueryParam } from "@/modules/context/types";
import styles from "./ParamStrip.module.css";

export interface ParamStripProps {
  params: QueryParam[];
  /** Map of param name -> current value (string from input). */
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  /** Called when the user clicks "Insert into editor" (or hits enter). */
  onInsert: () => void;
  /** Names of params that are required (no default) and currently empty. */
  missingRequired: string[];
}

/**
 * A single row above the editor showing one labelled input per param.
 * "Insert into editor" is disabled until all required params are filled.
 */
export function ParamStrip({
  params,
  values,
  onChange,
  onInsert,
  missingRequired,
}: ParamStripProps): JSX.Element {
  const isDisabled = missingRequired.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !isDisabled) {
      onInsert();
    }
  };

  return (
    <div className={styles.root} role="group" aria-label="Query parameters">
      {params.map((param) => {
        const isMissing = missingRequired.includes(param.name);
        const isRequired = param.default === null || param.default === undefined;
        return (
          <div key={param.name} className={styles.param}>
            <span
              className={styles.paramLabel}
              data-required={String(isRequired && isMissing)}
            >
              {param.name}
              {isRequired ? " *" : ""}
            </span>
            <input
              type="text"
              className={styles.paramInput}
              value={values[param.name] ?? ""}
              placeholder={param.type ?? ""}
              data-missing={String(isMissing)}
              aria-label={param.name}
              onChange={(e) => onChange(param.name, e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        );
      })}
      <div className={styles.actions}>
        {isDisabled && (
          <span className={styles.missingHint}>
            Required: {missingRequired.join(", ")}
          </span>
        )}
        <button
          type="button"
          className={styles.insertBtn}
          disabled={isDisabled}
          onClick={onInsert}
          title="Substitute parameters and write into the editor"
        >
          Insert into editor
        </button>
      </div>
    </div>
  );
}
