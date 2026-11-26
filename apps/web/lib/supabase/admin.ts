import { createClient } from "@supabase/supabase-js";
import { env } from "../env";

/**
 * SERVER ONLY. Deletes a person's Supabase sign-in record (email, password,
 * sessions) with the project's secret key. The only use of that key in GLIO.
 * Callers must have checked that the signed-in user is deleting themselves.
 */
export async function deleteAuthUser(userId: string): Promise<void> {
  const admin = createClient(env.supabaseUrl(), env.supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw Object.assign(new Error("Could not delete the sign-in record"), { code: `AUTH_${error.status ?? "ERROR"}` });
}
