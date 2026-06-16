import styles from "./FilterConnector.module.css";

export interface FilterConnectorProps {
  label: "AND" | "OR";
  className?: string;
}

export function FilterConnector({ label, className }: FilterConnectorProps) {
  return (
    <span className={[styles.connector, className].filter(Boolean).join(" ")}>
      {label}
    </span>
  );
}

export default FilterConnector;
