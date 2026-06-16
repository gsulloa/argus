export interface Tab {
  id: string;
  kind: string;
  title: string;
  closable: boolean;
  payload: unknown;
  /** When true the TabStrip renders a leading ● dirty indicator. */
  dirty?: boolean;
}
