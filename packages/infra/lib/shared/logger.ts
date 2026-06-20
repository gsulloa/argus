import { Logger } from "@aws-lambda-powertools/logger";

/**
 * Shared Powertools logger. Emits structured JSON with the service name and,
 * once `loggerWithContext` is wired into the middleware chain, the Lambda
 * request id / cold-start flag on every line.
 */
export const logger = new Logger({ serviceName: "argus-feedback" });
