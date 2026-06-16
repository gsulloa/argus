import { mssqlApi } from "../api";
import type {
  DatabaseInfo,
  RelationsResult,
  RoutineSignature,
  SchemaInfo,
  StructureResult,
  TableExtrasResult,
} from "../types";

export const schemaApi = {
  listSchemas: (id: string): Promise<SchemaInfo[]> =>
    mssqlApi.listSchemas(id),

  listDatabases: (id: string): Promise<DatabaseInfo[]> =>
    mssqlApi.listDatabases(id),

  listRelations: (id: string, schema: string): Promise<RelationsResult> =>
    mssqlApi.listRelations(id, schema),

  listStructure: (id: string, schema: string): Promise<StructureResult> =>
    mssqlApi.listStructure(id, schema),

  listTableExtras: (
    id: string,
    schema: string,
    relation: string,
  ): Promise<TableExtrasResult> =>
    mssqlApi.listTableExtras(id, schema, relation),

  getRoutineSignature: (
    id: string,
    schema: string,
    name: string,
    kind: string,
  ): Promise<RoutineSignature> =>
    mssqlApi.getRoutineSignature(id, schema, name, kind),

  getObjectDefinition: (id: string, schema: string, name: string): Promise<string | null> =>
    mssqlApi.getObjectDefinition(id, schema, name),
};
