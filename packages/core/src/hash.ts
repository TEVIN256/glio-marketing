import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Two payloads
 * with the same content always produce the same string, whatever key order
 * the platform used.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of the canonical JSON of `value`. */
export function sha256OfJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
