import { mysqlApi } from "../api";
import type {
  ApplyEditsResult,
  CountResult,
  EditOp,
  PrimaryKeyResult,
  QueryOptions,
  QueryResult,
} from "../types";

export type Origin = "auto" | "user";

export const dataApi = {
  queryTable: (
    id: string,
    schema: string,
    relation: string,
    options: QueryOptions,
    origin: Origin = "auto",
  ): Promise<QueryResult> =>
    mysqlApi.queryTable(id, schema, relation, options, origin),

  countTable: (
    id: string,
    schema: string,
    relation: string,
    options: Pick<QueryOptions, "filter_tree">,
    origin: Origin = "auto",
  ): Promise<CountResult> =>
    mysqlApi.countTable(id, schema, relation, options, origin),

  tablePrimaryKey: (
    id: string,
    schema: string,
    relation: string,
    origin: Origin = "auto",
  ): Promise<PrimaryKeyResult> =>
    mysqlApi.tablePrimaryKey(id, schema, relation, origin),

  applyTableEdits: (
    id: string,
    schema: string,
    relation: string,
    edits: EditOp[],
    origin: Origin = "user",
  ): Promise<ApplyEditsResult> =>
    mysqlApi.applyTableEdits(id, schema, relation, edits, origin),
};
