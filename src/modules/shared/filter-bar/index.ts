// Shared filter-bar primitive layer. See openspec/specs/filter-bar-visual-system/spec.md.
//
// Focus-target convention: consumer components SHOULD mark their preferred
// focus destination with the attribute `data-filter-focus-target="true"`.
// The host tab's ⌘F handler calls `filterBarRef.current.focus()`, which
// queries for that attribute and routes keyboard focus to it.
//
// FilterBarHandle: the imperative ref API exposed by FilterBar and QueryBuilder.

export { FilterBarShell } from "./FilterBarShell";
export type { FilterBarShellProps } from "./FilterBarShell";

export { FilterBarHeader } from "./FilterBarHeader";
export type { FilterBarHeaderProps } from "./FilterBarHeader";

export { FilterBarBody } from "./FilterBarBody";
export type { FilterBarBodyProps } from "./FilterBarBody";

export { FilterBarActions } from "./FilterBarActions";
export type { FilterBarActionsProps } from "./FilterBarActions";

export { FilterSegmentedToggle } from "./FilterSegmentedToggle";
export type { FilterSegmentedToggleProps, SegmentOption } from "./FilterSegmentedToggle";

export { FilterTypeBadge } from "./FilterTypeBadge";
export type { FilterTypeBadgeProps } from "./FilterTypeBadge";

export { FilterConnector } from "./FilterConnector";
export type { FilterConnectorProps } from "./FilterConnector";

export { FilterRowAddButton } from "./FilterRowAddButton";
export type { FilterRowAddButtonProps } from "./FilterRowAddButton";

export { FilterKeyHint } from "./FilterKeyHint";
export type { FilterKeyHintProps } from "./FilterKeyHint";

export { PrimaryButton } from "./PrimaryButton";
export type { PrimaryButtonProps } from "./PrimaryButton";

export { SecondaryButton } from "./SecondaryButton";
export type { SecondaryButtonProps } from "./SecondaryButton";

export { EmptyBodyRow } from "./EmptyBodyRow";
export type { EmptyBodyRowProps } from "./EmptyBodyRow";

export { RootCombinatorToggle } from "./RootCombinatorToggle";
export type { RootCombinatorToggleProps } from "./RootCombinatorToggle";

export { RowApplyButton } from "./RowApplyButton";
export type { RowApplyButtonProps } from "./RowApplyButton";

/** Imperative ref API exposed by FilterBar and QueryBuilder. */
export interface FilterBarHandle {
  /** Expand if collapsed, then focus the first interactive control. */
  focus(): void;
}
