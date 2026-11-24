"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseEmailLink } from "@/lib/email-link";
import { NEXT_COOKIE, safeNext } from "@/lib/safe-next";
import { supabaseAsUser } from "@/lib/supabase/server";

/**
 * Verify the token from a sign-up or password reset email (after the person pressed
 * the button, so email security scanners that open links can't use it up first).
 * Signs the person in: a reset continues to /reset-password, a confirmation to the
 * page remembered at sign-up (e.g. an invite) or the app.
 */
export async function confirmEmailLink(formData: FormData) {
  const link = parseEmailLink(formData.get("token_hash"), formData.get("type"));
  if (!link) redirect("/login?e=link");
  const supabase = await supabaseAsUser();
  const { error } = await supabase.auth.verifyOtp({ type: link.type, token_hash: link.tokenHash });
  if (error) {
    console.error(JSON.stringify({ event: "email_link_failed", type: link.type, code: error.code ?? null, status: error.status ?? null }));
    redirect(link.type === "recovery" ? "/login?mode=forgot&e=expired" : "/login?e=link");
  }
  const jar = await cookies();
  const next = link.type === "recovery" ? "/reset-password" : safeNext(jar.get(NEXT_COOKIE)?.value);
  jar.set(NEXT_COOKIE, "", { path: "/", maxAge: 0 });
  redirect(next);
}
