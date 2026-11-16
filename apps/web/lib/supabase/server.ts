import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "../env";

/**
 * Supabase client acting AS THE SIGNED-IN USER. Every query through it is
 * subject to row-level security, so it can only ever see what that user may
 * see. Use this for all reads in pages.
 */
export async function supabaseAsUser() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabasePublishableKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies can't be set there; proxy.ts refreshes the session.
        }
      },
    },
  });
}

/** The signed-in user, or a redirect to the login page. */
export async function requireUser() {
  const supabase = await supabaseAsUser();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  return { supabase, user: data.user };
}
