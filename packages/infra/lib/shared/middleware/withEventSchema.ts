import type { MiddlewareObj } from "@middy/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { z } from "zod";

import { apiResponse } from "../helpers/apiResponse";

/**
 * Event carrying the parsed-and-validated body. The handler reads
 * `event.validatedBody` instead of re-parsing `event.body`.
 */
export type ValidatedEvent<T> = APIGatewayProxyEventV2 & { validatedBody: T };

/**
 * Parses the JSON body and validates it against `schema` before the handler
 * runs. On malformed JSON or a schema violation it short-circuits with a 400
 * describing the offending fields — the handler only ever sees valid input.
 */
export const withEventSchema = <S extends z.ZodType>(
  schema: S
): MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2> => ({
  before: async (request) => {
    let raw: unknown;
    try {
      raw = request.event.body ? JSON.parse(request.event.body) : {};
    } catch {
      request.response = apiResponse(400, { error: "Invalid JSON body" });
      return;
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      request.response = apiResponse(400, {
        error: "Validation failed",
        details: z.flattenError(result.error),
      });
      return;
    }

    (request.event as ValidatedEvent<z.infer<S>>).validatedBody = result.data;
  },
});
