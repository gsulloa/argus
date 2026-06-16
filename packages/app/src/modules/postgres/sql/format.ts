import { format as sqlFormat } from "sql-formatter";

const PRESET = {
  language: "postgresql" as const,
  keywordCase: "upper" as const,
  identifierCase: "preserve" as const,
  dataTypeCase: "upper" as const,
  functionCase: "lower" as const,
  indentStyle: "standard" as const,
  tabWidth: 2,
  expressionWidth: 80,
  linesBetweenQueries: 1,
};

export function formatSql(input: string): string {
  if (input.trim().length === 0) return input;
  return sqlFormat(input, PRESET);
}
