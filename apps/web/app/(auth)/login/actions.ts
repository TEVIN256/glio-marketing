"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NEXT_COOKIE, safeNext } from "@/lib/safe-next";
import { supabaseAsUser } from "@/lib/supabase/server";

function credentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
}

/** Supabase Auth error -> the specific message shown on the login page (never the raw text). */
function authErrorKey(code: string | undefined): string {
  if (code === "email_not_confirmed") return "unconfirmed";
  if (code === "invalid_credentials") return "credentials";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "rate";
  if (code === "user_already_exists" || code === "email_exists") return "exists";
  if (code === "weak_password") return "weak";
  return "auth";
}
const withNext = (path: string, next: string) => (next === "/app" ? path : `${path}&next=${encodeURIComponent(next)}`);

export async function signIn(formData: FormData) {
  const { email, password } = credentials(formData);
  const supabase = await supabaseAsUser();
  const next = safeNext(formData.get("next"));
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(JSON.stringify({ event: "sign_in_failed", code: error.code ?? null, status: error.status ?? null }));
    redirect(withNext(`/login?e=${authErrorKey(error.code)}`, next));
  }
  redirect(next);
}

/** Send the sign-up confirmation email again. */
export async function resendConfirmation(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const next = safeNext(formData.get("next"));
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await supabaseAsUser();
  const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${origin}/auth/callback` } });
  if (error) {
    console.error(JSON.stringify({ event: "resend_confirmation_failed", code: error.code ?? null, status: error.status ?? null }));
    redirect(withNext(`/login?e=${authErrorKey(error.code)}`, next));
  }
  redirect(withNext("/login?m=check", next));
}

export async function signUp(formData: FormData) {
  const { email, password } = credentials(formData);
  if (password.length < 8) redirect("/login?mode=signup&e=signup");
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await supabaseAsUser();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    console.error(JSON.stringify({ event: "sign_up_failed", code: error.code ?? null, status: error.status ?? null }));
    const key = authErrorKey(error.code);
    redirect(withNext(`/login?mode=signup&e=${key === "auth" ? "signup" : key}`, safeNext(formData.get("next"))));
  }
  // Remember where to go after the confirmation link (e.g. an invite page), for one day.
  const next = safeNext(formData.get("next"));
  if (next !== "/app") {
    (await cookies()).set(NEXT_COOKIE, next, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 86_400 });
  }
  redirect("/login?m=check");
}

/**
 * Send a password reset link. Always answers the same way, whether or not an
 * account exists (no way to test which emails are registered). The link comes
 * back to /auth/callback, which then opens /reset-password (remembered in a cookie).
 */
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) redirect("/login?mode=forgot&e=email");
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await supabaseAsUser();
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback` });
  if (error) {
    console.error(JSON.stringify({ event: "password_reset_request_failed", code: error.code ?? null, status: error.status ?? null }));
    if (authErrorKey(error.code) === "rate") redirect("/login?mode=forgot&e=rate");
  }
  (await cookies()).set(NEXT_COOKIE, "/reset-password", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3_600 });
  redirect("/login?mode=forgot&m=reset_sent");
}

/** Set a new password for the signed-in person (after following the reset link). */
export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 8) redirect("/reset-password?e=weak");
  if (password !== confirm) redirect("/reset-password?e=mismatch");
  const supabase = await supabaseAsUser();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?mode=forgot&e=expired");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error(JSON.stringify({ event: "password_update_failed", code: error.code ?? null, status: error.status ?? null }));
    redirect(`/reset-password?e=${error.code === "same_password" ? "same" : authErrorKey(error.code)}`);
  }
  redirect("/app?pw=changed");
}

