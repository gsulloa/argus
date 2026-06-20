import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import type { MiddlewareObj } from "@middy/core";

import { logger } from "../logger";

/**
 * Injects Lambda context (request id, cold-start flag, function name) into the
 * shared logger so every log line carries correlation data without the handler
 * threading it through.
 */
export const loggerWithContext = (): MiddlewareObj =>
  injectLambdaContext(logger);
