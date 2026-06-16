/**
 * Ejemplo de modelo DynamoDB usando BaseModel.
 *
 * Uso típico:
 * - Crear: `const item = new Example(props); dynamoClient.send(new PutCommand({ TableName, Item: item.toDynamoObject() }));`
 * - Leer: `const result = await dynamoClient.send(new GetCommand(...)); const item = Example.fromDynamoObject(result.Item!);`
 * - Query: `query.Items?.map((item) => Example.fromDynamoObject(item)) ?? []`
 */

import { z } from "zod";

import { dateTransformer } from "@/utils/zod";

import { BaseModel } from "./base";

// --- Schemas Zod ---

const exampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number().optional(),
  createdAt: dateTransformer()
    .default(() => new Date())
    .optional(),
  updatedAt: dateTransformer()
    .default(() => new Date())
    .optional(),
});

export const exampleCreationSchema = exampleSchema.omit({ id: true }).extend({
  id: z.string().optional(),
});
export type ExampleCreationProps = z.infer<typeof exampleCreationSchema>;

export const exampleUpdateSchema = exampleSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial();

// --- Modelo ---

export class Example extends BaseModel {
  name: string;
  value?: number;

  constructor(props: ExampleCreationProps) {
    const parsed = exampleCreationSchema.parse(props);
    super(parsed);
    Object.assign(this, parsed);
  }

  /**
   * Partition Key (PK). Define el prefijo para queries por tipo de entidad.
   * Ej: Query con KeyConditionExpression "PK = :pk" y ":pk": "EXAMPLE#"
   */
  get PK(): string {
    return "EXAMPLE#";
  }

  /**
   * Sort Key (SK). Identificador único del ítem dentro de la partición.
   * Incluir id permite GetItem por PK+SK y evita colisiones.
   */
  get SK(): string {
    return `EXAMPLE#${this.id}`;
  }

  /**
   * Objeto validado para API/respuestas. Override si añades campos propios.
   */
  toObject() {
    return exampleSchema.parse(this);
  }
}
