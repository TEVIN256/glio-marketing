"use server";

import { redirect } from "next/navigation";
import { accountDeletionBlockers, prepareAccountDeletion } from "@glio/sync";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { serverDb } from "@/lib/server-db";
import { deleteAuthUser } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";

/**
 * Delete the signed-in person's own GLIO account (ADR-037): only themselves, only
 * after typing their email, and not while they are the only owner of a workspace.
 * Their memberships go with it; past actions keep their bare id ("former member").
 */
export async function deleteMyAccount(formData: FormData) {
  const { supabase, user } = await requireUser();
  if (!env.accountDeletionConfigured()) redirect("/account?e=not_configured");
  if (String(formData.get("confirm") ?? "").trim().toLowerCase() !== (user.email ?? "").toLowerCase()) redirect("/account?e=confirm");

  let failure: string | null = null;
  try {
    const db = serverDb();
    if ((await accountDeletionBlockers(db, user.id)).length > 0) throw Object.assign(new Error("Only owner"), { code: "SOLE_OWNER" });
    await prepareAccountDeletion(db, user.id);
    await deleteAuthUser(user.id);
    console.info(JSON.stringify({ event: "account_deleted" }));
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "account_delete_failed", code: d.code, error: d.message }));
    failure = d.code;
  }
  if (failure) redirect(`/account?e=${failure === "SOLE_OWNER" ? "sole_owner" : "delete"}&code=${encodeURIComponent(failure)}`);
  await supabase.auth.signOut().catch(() => {});
  redirect("/login?m=account_deleted");
}
