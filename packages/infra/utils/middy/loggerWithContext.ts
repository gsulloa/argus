import { Context } from "aws-lambda";

import { logger } from "../logger";

export const loggerWithContext = () => {
  return {
    before: (request: { context: Context; event: unknown }) => {
      logger.addContext(request.context);
      logger.debug({ message: "Event", event: request.event });
    },
    after: () => {
      logger.resetKeys();
    },
  };
};
