export type ValidateResult =
  | { ok: true; canonical: string }
  | { ok: false; error: string };

export function validateJsonInput(raw: string): ValidateResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, canonical: "" };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, canonical: JSON.stringify(parsed) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function hasSmartQuotes(s: string): boolean {
  return /[“”‘’]/.test(s);
}
