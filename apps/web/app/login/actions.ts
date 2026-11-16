"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect("/login?e=auth");
  redirect("/");
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
  redirect("/login?m=check");
}
