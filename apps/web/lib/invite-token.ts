import { createHash, randomBytes } from "node:crypto";

/** A new invite secret (goes only into the link) and its SHA-256 (the only thing stored). */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Tokens are 43 base64url characters; anything else is rejected before touching the database. */
export const isInviteToken = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

/** Short-lived cookie that shows a new invite link once to the owner who created it (never in URLs or logs). */
export const INVITE_LINK_COOKIE = "glio_invite_link";
