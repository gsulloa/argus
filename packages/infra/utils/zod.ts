import { z } from "zod";

export const dateTransformer = () =>
  z.union([z.string(), z.date(), z.null()]).transform((val) => {
    if (val == null) return null;
    const parsed = val instanceof Date ? val : new Date(val);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  });
