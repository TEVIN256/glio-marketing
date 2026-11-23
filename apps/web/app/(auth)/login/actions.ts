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

export async function signIn(formData: FormData) {
  const { email, password } = credentials(formData);
  const supabase = await supabaseAsUser();
  const next = safeNext(formData.get("next"));
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?e=auth${next !== "/app" ? `&next=${encodeURIComponent(next)}` : ""}`);
  redirect(next);
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
  if (error) redirect("/login?mode=signup&e=signup");
  // Remember where to go after the confirmation link (e.g. an invite page), for one day.
  const next = safeNext(formData.get("next"));
  if (next !== "/app") {
    (await cookies()).set(NEXT_COOKIE, next, { httpOnly: true, secure: true, sameSite: "lax", path: "/auth", maxAge: 86_400 });
  }
  redirect("/login?m=check");
}
