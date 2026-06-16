export interface TableEntryParts {
  schema: string;
  name: string;
  connectionName: string;
}

const TIER_EXACT_NAME = 0.99;
const TIER_PREFIX_NAME = 0.9;
const TIER_SUBSTR_NAME = 0.8;
const TIER_EXACT_SCHEMA = 0.7;
const TIER_PREFIX_SCHEMA = 0.65;
const TIER_SUBSTR_SCHEMA = 0.6;
const TIER_EXACT_CONN = 0.55;
const TIER_PREFIX_CONN = 0.5;
const TIER_SUBSTR_CONN = 0.45;
const FALLBACK_MAX = 0.4;
const TIE_BONUS_MAX = 0.04;

function tieBonus(matchedFieldLength: number): number {
  return (1 / (1 + matchedFieldLength)) * TIE_BONUS_MAX;
}

type MatchTier = "exact" | "prefix" | "substring" | "none";

function matchTier(query: string, field: string): MatchTier {
  if (!query) return "none";
  if (field === query) return "exact";
  if (field.startsWith(query)) return "prefix";
  if (field.includes(query)) return "substring";
  return "none";
}

function tierValue(t: MatchTier): number {
  switch (t) {
    case "exact":
      return 1;
    case "prefix":
      return 0.7;
    case "substring":
      return 0.5;
    case "none":
      return 0;
  }
}

function singleSegmentScore(q: string, parts: TableEntryParts): number {
  const { schema, name, connectionName } = parts;

  const nameT = matchTier(q, name);
  if (nameT === "exact") return TIER_EXACT_NAME;
  if (nameT === "prefix") return TIER_PREFIX_NAME + tieBonus(name.length);
  if (nameT === "substring") return TIER_SUBSTR_NAME + tieBonus(name.length);

  const schemaT = matchTier(q, schema);
  if (schemaT === "exact") return TIER_EXACT_SCHEMA;
  if (schemaT === "prefix") return TIER_PREFIX_SCHEMA + tieBonus(schema.length);
  if (schemaT === "substring") return TIER_SUBSTR_SCHEMA + tieBonus(schema.length);

  const connT = matchTier(q, connectionName);
  if (connT === "exact") return TIER_EXACT_CONN;
  if (connT === "prefix") return TIER_PREFIX_CONN + tieBonus(connectionName.length);
  if (connT === "substring") return TIER_SUBSTR_CONN + tieBonus(connectionName.length);

  return 0;
}

function twoSegmentScore(
  qSchema: string,
  qName: string,
  parts: TableEntryParts,
): number {
  const schemaT = matchTier(qSchema, parts.schema);
  const nameT = matchTier(qName, parts.name);
  if (schemaT === "none" && nameT === "none") return 0;

  // Combined band: 0.50 + 0.30 * nameTier + 0.15 * schemaTier + tieBonus
  // - exact schema + exact name  → 0.95
  // - exact schema + prefix name → 0.86
  // - prefix schema + prefix name → 0.815
  // - no schema + prefix name    → 0.71
  // - exact schema + no name     → 0.65
  const base =
    0.5 + 0.3 * tierValue(nameT) + 0.15 * tierValue(schemaT);
  return base + tieBonus(parts.name.length);
}

/**
 * Sequential subsequence scorer used as a fuzzy fallback. Returns a value in
 * [0, 1] based on whether the query characters appear in order inside the
 * haystack, with a penalty for gaps and length mismatch. Keeps the helper
 * self-contained (no dep on cmdk's private command-score module).
 */
function fuzzySubsequenceScore(haystack: string, query: string): number {
  if (!query) return 1;
  if (!haystack) return 0;
  let hi = 0;
  let matched = 0;
  let gapPenalty = 0;
  let lastIndex = -1;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    let found = -1;
    while (hi < haystack.length) {
      if (haystack[hi] === ch) {
        found = hi;
        hi++;
        break;
      }
      hi++;
    }
    if (found === -1) return 0;
    if (lastIndex !== -1) gapPenalty += found - lastIndex - 1;
    lastIndex = found;
    matched++;
  }
  // matched === query.length here
  const density = matched / (matched + gapPenalty);
  const lengthRatio = matched / haystack.length;
  return density * 0.7 + lengthRatio * 0.3;
}

/**
 * Score a single table-quick-switcher entry against the user's query.
 *
 * Returns a value in [0, 1] following cmdk's filter contract: higher is
 * better, 0 hides the row. Ranking is deterministic — structured tiers
 * (exact / prefix / substring on `name`, then `schema`, then
 * `connectionName`) always outrank the fuzzy fallback used as a tie-breaker
 * / safety net so mid-word matches still surface.
 *
 * `fallbackScore` is an optional cmdk-style fuzzy score in [0, 1]; if
 * omitted the function computes its own subsequence-based fallback over
 * `schema.name connectionName`.
 */
export function scoreTableEntry(
  query: string,
  parts: TableEntryParts,
  fallbackScore?: number,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const normalized: TableEntryParts = {
    schema: parts.schema.toLowerCase(),
    name: parts.name.toLowerCase(),
    connectionName: parts.connectionName.toLowerCase(),
  };

  let structured = 0;
  const dotIdx = q.indexOf(".");
  if (dotIdx >= 0) {
    const qSchema = q.slice(0, dotIdx);
    const qName = q.slice(dotIdx + 1);
    if (qSchema && qName) {
      structured = twoSegmentScore(qSchema, qName, normalized);
    } else if (qName) {
      // ".foo" — treat as name-only query
      structured = singleSegmentScore(qName, normalized);
    } else if (qSchema) {
      // "foo." — treat as schema-or-name query
      structured = singleSegmentScore(qSchema, normalized);
    }
  } else {
    structured = singleSegmentScore(q, normalized);
  }

  const rawFallback =
    fallbackScore ??
    fuzzySubsequenceScore(
      `${normalized.schema}.${normalized.name} ${normalized.connectionName}`,
      q,
    );
  const fallback = Math.max(0, Math.min(1, rawFallback)) * FALLBACK_MAX;

  return Math.max(structured, fallback);
}
