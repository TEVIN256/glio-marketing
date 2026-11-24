/**
 * Links in Supabase Auth emails (sign-up confirmation, password reset) point at
 * /auth/confirm?token_hash=…&type=… (our own email templates, supabase/templates/).
 * Unlike the old ?code= links, they work in any browser: the token is verified
 * on the server, not matched to the browser that asked for it.
 */
export type EmailLinkType = "email" | "signup" | "recovery";

export interface EmailLink {
  tokenHash: string;
  type: EmailLinkType;
}

/** Only well-formed links; anything else is shown as "not valid" without calling Supabase. */
export function parseEmailLink(tokenHash: unknown, type: unknown): EmailLink | null {
  if (typeof tokenHash !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(tokenHash)) return null;
  if (type !== "email" && type !== "signup" && type !== "recovery") return null;
  return { tokenHash, type };
}
