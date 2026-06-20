import type { MiddlewareObj } from "@middy/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { apiResponse } from "../helpers/apiResponse";
import { logger } from "../logger";

/**
 * Catches anything that escapes the handler, logs it with full context, and
 * returns a standardised 500 — so even unexpected failures flow through
 * `apiResponse` instead of surfacing as a raw Lambda error.
 */
export const withErrorHandler = (): MiddlewareObj<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2
> => ({
  onError: async (request) => {
    if (request.response !== undefined && request.response !== null) return;
    if (request.error) {
      logger.error("Unhandled error in handler", request.error);
    } else {
      logger.error("Unhandled error in handler");
    }
    request.response = apiResponse(500, { error: "Internal server error" });
  },
});
