import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const environmentSchema = z.object({
  DYNAMO_TABLE_NAME: z.string(),
});
const environment = environmentSchema.parse(process.env);
export const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({}),
  {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: true,
      convertClassInstanceToMap: true,
    },
    unmarshallOptions: { wrapNumbers: false },
  }
);

export const DYNAMO_TABLE_NAME = environment.DYNAMO_TABLE_NAME;
