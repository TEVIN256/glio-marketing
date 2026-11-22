import { timingSafeEqual } from "node:crypto";

/** True only for "Bearer <CRON_SECRET>" with a non-empty secret (constant-time compare). */
export function cronAuthorized(header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
