/** Where to go after signing in: only paths inside GLIO (no other sites, no "//host" tricks). */
export const NEXT_COOKIE = "glio_next";

export function safeNext(value: unknown, fallback = "/app"): string {
  if (typeof value !== "string" || value.length > 300) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}
