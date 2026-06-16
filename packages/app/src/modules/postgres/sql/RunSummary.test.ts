import { describe, expect, it } from "vitest";
import { formatElapsed } from "./RunSummary";

describe("formatElapsed", () => {
  it("shows just Running… under a second", () => {
    expect(formatElapsed(0)).toBe("Running…");
    expect(formatElapsed(400)).toBe("Running…");
    expect(formatElapsed(999)).toBe("Running…");
  });

  it("shows seconds with one decimal between 1s and 60s", () => {
    expect(formatElapsed(1000)).toBe("Running… 1.0s");
    expect(formatElapsed(1234)).toBe("Running… 1.2s");
    expect(formatElapsed(12_400)).toBe("Running… 12.4s");
    expect(formatElapsed(59_900)).toBe("Running… 59.9s");
  });

  it("shows m:ss past 60s", () => {
    expect(formatElapsed(60_000)).toBe("Running… 1:00");
    expect(formatElapsed(83_000)).toBe("Running… 1:23");
    expect(formatElapsed(605_000)).toBe("Running… 10:05");
  });
});
