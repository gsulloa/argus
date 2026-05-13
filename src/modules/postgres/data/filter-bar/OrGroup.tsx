import { X } from "lucide-react";
import { Plus } from "lucide-react";
import { ConditionRow } from "./ConditionRow";
import type { Condition, DataColumn, FilterNode } from "../types";
import styles from "./FilterBar.module.css";

interface Props {
  group: Extract<FilterNode, { kind: "or_group" }>;
  columns: DataColumn[];
  onUpdateChild(childIndex: number, next: Condition): void;
  onRemoveChild(childIndex: number): void;
  onAddChild(): void;
  onRemoveGroup(): void;
}

export function OrGroup({
  group,
  columns,
  onUpdateChild,
  onRemoveChild,
  onAddChild,
  onRemoveGroup,
}: Props) {
  return (
    <div className={styles.orGroup}>
      <div className={styles.orGroupHeader}>
        <span>OR group</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={styles.removeBtn}
          aria-label="Remove OR group"
          onClick={onRemoveGroup}
          title="Remove OR group"
        >
          <X size={11} />
        </button>
      </div>
      {group.children.map((child, i) => {
        if (child.kind !== "condition") return null;
        return (
          <div key={i} className={styles.orGroupRow}>
            <span className={styles.orConnector}>{i === 0 ? "" : "OR"}</span>
            <ConditionRow
              condition={{
                column: child.column,
                op: child.op,
                value: child.value,
              }}
              columns={columns}
              onChange={(next) => onUpdateChild(i, next)}
              onRemove={() => onRemoveChild(i)}
            />
          </div>
        );
      })}
      <div className={styles.addRow}>
        {/* Use a raw button here to preserve aria-label="Add OR row" for test compatibility.
            FilterRowAddButton does not expose an aria-label prop. */}
        <button
          type="button"
          className={styles.addBtn}
          onClick={onAddChild}
          aria-label="Add OR row"
        >
          <Plus size={10} /> OR row
        </button>
      </div>
    </div>
  );
}
