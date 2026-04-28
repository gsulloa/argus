export interface Tab {
  id: string;
  kind: string;
  title: string;
  closable: boolean;
  payload: unknown;
}
