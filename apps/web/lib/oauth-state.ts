import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth "state" for connecting an ad platform. The random state goes to the
 * platform and back; the same value plus the workspace and client being
 * connected is kept in a short-lived httpOnly cookie. On return, the two must
 * match (stops another site from completing a connection in your session).
 */
export const TIKTOK_OAUTH_COOKIE = "glio_tiktok_oauth";
// Long enough to read TikTok's permission page (and switch accounts) without rushing.
export const OAUTH_MAX_AGE_SECONDS = 1800;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendingConnection {
  state: string;
  ws: string;
  client: string;
  iat: number; // ms since epoch
}

export function newPendingConnection(ws: string, client: string, now = Date.now()): { state: string; cookie: string } {
  if (!UUID.test(ws) || !UUID.test(client)) throw new Error("Invalid workspace or client id");
  const state = randomBytes(24).toString("base64url");
  const pending: PendingConnection = { state, ws, client, iat: now };
  return { state, cookie: Buffer.from(JSON.stringify(pending)).toString("base64url") };
}

/** The pending connection if the cookie is valid, fresh, and its state equals the returned one; otherwise null. */
export function readPendingConnection(
  cookie: string | undefined, returnedState: string | null | undefined, now = Date.now(),
): PendingConnection | null {
  if (!cookie || !returnedState) return null;
  let p: Partial<PendingConnection>;
  try {
    p = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p.state !== "string" || typeof p.ws !== "string" || typeof p.client !== "string" || typeof p.iat !== "number") return null;
  if (!UUID.test(p.ws) || !UUID.test(p.client)) return null;
  if (now - p.iat > OAUTH_MAX_AGE_SECONDS * 1000 || p.iat > now + 60_000) return null;
  const a = Buffer.from(p.state);
  const b = Buffer.from(returnedState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return p as PendingConnection;
}
