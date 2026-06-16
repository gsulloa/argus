import { describe, expect, it } from "vitest";
import { scoreTableEntry, type TableEntryParts } from "./scoreTableEntry";

function entry(
  schema: string,
  name: string,
  connectionName = "supabase-prod",
): TableEntryParts {
  return { schema, name, connectionName };
}

function rank(
  query: string,
  entries: TableEntryParts[],
): TableEntryParts[] {
  return [...entries]
    .map((e) => ({ e, s: scoreTableEntry(query, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e);
}

describe("scoreTableEntry", () => {
  it("returns a non-zero score for an empty query", () => {
    expect(scoreTableEntry("", entry("public", "users"))).toBeGreaterThan(0);
  });

  it("ranks an exact name match above a longer substring match", () => {
    const order = entry("client", "order");
    const longer = entry("client", "assistant_manual_pending_orders");
    const ordered = rank("order", [longer, order]);
    expect(ordered[0]).toBe(order);
    expect(ordered[1]).toBe(longer);
  });

  it("ranks a prefix on the name above a substring elsewhere", () => {
    const orders = entry("public", "orders");
    const longer = entry("client", "assistant_manual_pending_orders");
    const ordered = rank("ord", [longer, orders]);
    expect(ordered[0]).toBe(orders);
    expect(ordered[1]).toBe(longer);
  });

  it("ranks two-segment auth.us preferring exact schema match", () => {
    const authUsers = entry("auth", "users");
    const authUserSessions = entry("auth", "user_sessions");
    const publicUsers = entry("public", "users");
    const ordered = rank("auth.us", [
      publicUsers,
      authUserSessions,
      authUsers,
    ]);
    expect(ordered[0]).toBe(authUsers);
    expect(ordered[1]).toBe(authUserSessions);
    expect(ordered[2]).toBe(publicUsers);
  });

  it("matches by relation name via fuzzy fallback (usr → users)", () => {
    const users = entry("public", "users");
    const sessions = entry("auth", "sessions");
    const ordered = rank("usr", [sessions, users]);
    expect(ordered[0]).toBe(users);
  });

  it("filters by connection name and hides non-matching entries", () => {
    const stagingA = entry("public", "users", "supabase-staging");
    const stagingB = entry("public", "events", "supabase-staging");
    const prod = entry("public", "users", "supabase-prod");
    const ordered = rank("staging", [prod, stagingA, stagingB]);
    expect(ordered).toContain(stagingA);
    expect(ordered).toContain(stagingB);
    expect(ordered).not.toContain(prod);
  });

  it("keeps fuzzy fallback matches visible (scrip → subscriptions)", () => {
    const subs = entry("public", "subscriptions");
    const orders = entry("public", "orders");
    const ordered = rank("scrip", [orders, subs]);
    expect(ordered[0]).toBe(subs);
  });

  it("hides entries with no structured or fuzzy match", () => {
    const subs = entry("public", "subscriptions");
    // "xyzqq" doesn't appear at all
    expect(scoreTableEntry("xyzqq", subs)).toBe(0);
  });

  it("is case-insensitive", () => {
    const users = entry("Public", "Users", "Supabase-Prod");
    expect(scoreTableEntry("USERS", users)).toBeGreaterThanOrEqual(
      scoreTableEntry("users", users),
    );
  });

  it("ranks a shorter prefix-name match above a longer one (length tiebreak)", () => {
    const users = entry("public", "users");
    const userEvents = entry("public", "user_events");
    const ordered = rank("user", [userEvents, users]);
    expect(ordered[0]).toBe(users);
  });

  it("uses fallbackScore when provided and combines with structured tiers", () => {
    // structured tier must dominate any reasonable fallbackScore
    const exactName = entry("public", "order");
    const structuredScore = scoreTableEntry("order", exactName, 0);
    const withMaxFallback = scoreTableEntry("order", exactName, 1);
    // exact name tier is 0.99; fallback contribution is at most 0.4 — so the
    // returned value should not change (max of the two).
    expect(structuredScore).toBeCloseTo(withMaxFallback, 5);
    expect(structuredScore).toBeGreaterThan(0.95);
  });
});
