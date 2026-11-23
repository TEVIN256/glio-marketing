"use server";

import { redirect } from "next/navigation";
import { hashInviteToken, isInviteToken } from "@/lib/invite-token";
import { requireUser } from "@/lib/supabase/server";

/** Join through an invite: accept_invitation() checks validity and that the signed-in email is the invited one. */
export async function acceptInvite(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!isInviteToken(token)) redirect("/app");
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("accept_invitation", { p_token_hash: hashInviteToken(token) });
  if (error || !data) redirect(`/invite/${token}?e=${encodeURIComponent(error?.code ?? "UNKNOWN")}`);
  redirect(`/w/${data}?joined=1`);
}

/** Signed in with the wrong account: sign out and come back to this invite. */
export async function switchAccount(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!isInviteToken(token)) redirect("/login");
  const { supabase } = await requireUser();
  await supabase.auth.signOut();
  redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
}

