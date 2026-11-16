"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { LANG_COOKIE } from "@/lib/i18n";
import { supabaseAsUser } from "@/lib/supabase/server";

export async function switchLanguage(formData: FormData) {
  const lang = formData.get("lang") === "en" ? "en" : "ar";
  (await cookies()).set(LANG_COOKIE, lang, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  // Return to the page the switch was pressed on (same origin only).
  let back = "/";
  try {
    const referer = (await headers()).get("referer");
    if (referer) back = new URL(referer).pathname + new URL(referer).search;
  } catch {
    back = "/";
  }
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
}

export async function signOut() {
  const supabase = await supabaseAsUser();
  await supabase.auth.signOut();
  redirect("/login");
}
