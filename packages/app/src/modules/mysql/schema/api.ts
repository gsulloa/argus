import { mysqlApi } from "../api";
import type {
  RelationsResult,
  RoutineSignature,
  SchemaInfo,
  StructureResult,
  TableExtrasResult,
} from "../types";

export const schemaApi = {
  listSchemas: (id: string): Promise<SchemaInfo[]> =>
    mysqlApi.listSchemas(id),

  listRelations: (id: string, schema: string): Promise<RelationsResult> =>
    mysqlApi.listRelations(id, schema),

  listStructure: (id: string, schema: string): Promise<StructureResult> =>
    mysqlApi.listStructure(id, schema),

  listTableExtras: (id: string, schema: string, relation: string): Promise<TableExtrasResult> =>
    mysqlApi.listTableExtras(id, schema, relation),

  getRoutineSignature: (
    id: string,
    schema: string,
    name: string,
    kind: string,
  ): Promise<RoutineSignature> =>
    mysqlApi.getRoutineSignature(id, schema, name, kind),
};
