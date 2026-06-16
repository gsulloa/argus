import { mssqlApi } from "../api";
import type { ApplyEditsResult, EditOp, PrimaryKeyResult } from "../types";

export type Origin = "auto" | "user";

export const editApi = {
  tablePrimaryKey: (
    id: string,
    schema: string,
    relation: string,
    origin: Origin = "auto",
  ): Promise<PrimaryKeyResult> =>
    mssqlApi.tablePrimaryKey(id, schema, relation, origin),

  applyTableEdits: (
    id: string,
    schema: string,
    relation: string,
    edits: EditOp[],
    origin: Origin = "user",
  ): Promise<ApplyEditsResult> =>
    mssqlApi.applyTableEdits(id, schema, relation, edits, origin),
};
