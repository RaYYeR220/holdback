export type KaneEvent = { type: string; v?: number; verb?: string } & Record<string, unknown>;

/**
 * Parse one line of kane-cli stdout. Returns null for anything that is not a
 * JSON object with a string `type` (blank lines, update notices, partial
 * output). Never throws.
 */
export function parseLine(line: string): KaneEvent | null {
  const s = line.trim();
  if (s.length === 0 || s[0] !== "{") return null;
  try {
    const v: unknown = JSON.parse(s);
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string") {
      return v as KaneEvent;
    }
    return null;
  } catch {
    return null;
  }
}
