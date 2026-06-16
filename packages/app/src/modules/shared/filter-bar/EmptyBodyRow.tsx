import React, { type ReactNode } from "react";
import styles from "./EmptyBodyRow.module.css";

export interface EmptyBodyRowProps {
  label: string;
  children?: ReactNode;
  className?: string;
}

export function EmptyBodyRow({ label, children, className }: EmptyBodyRowProps) {
  // Convert children to array so we can interleave · separators between each pair,
  // plus one separator between the label and the first child.
  const childArray = React.Children.toArray(children);

  return (
    <div className={[styles.empty, className].filter(Boolean).join(" ")}>
      {label}
      {childArray.map((child, i) => (
        <React.Fragment key={i}>
          <span aria-hidden="true" className={styles.sep}>
            ·
          </span>
          {child}
        </React.Fragment>
      ))}
    </div>
  );
}

export default EmptyBodyRow;
