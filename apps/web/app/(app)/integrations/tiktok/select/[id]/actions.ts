"use server";

import { redirect } from "next/navigation";
import { VaultSecretStore, cancelPendingConnection, confirmPendingConnection, loadPendingConnection } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { describeError } from "@/lib/errors";
import { serverDb } from "@/lib/server-db";
import { requireUser } from "@/lib/supabase/server";
import { finishTikTokConnection } from "@/lib/tiktok-connect";

/** Load the user's own pending choice and re-check they may still manage that client. */
async function authorised(id: string) {
  const { user } = await requireUser();
  const pending = await loadPendingConnection(serverDb(), { id, userId: user.id });
  if (!pending) return null;
  const access = await clientAccess(pending.workspaceId, pending.clientId);
  return access.canManage ? { user, pending, base: `/w/${pending.workspaceId}/c/${pending.clientId}` } : null;
}

/** Attach only the chosen accounts, then sync their last 30 days. */
export async function connectChosenAccounts(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const ctx = await authorised(id);
  if (!ctx) redirect(`/integrations/tiktok/select/${encodeURIComponent(id)}`);
  const chosen = formData.getAll("account").map(String);

  let target: string;
  try {
    const db = serverDb();
    const result = await confirmPendingConnection({ db, secrets: new VaultSecretStore(db) }, { id, userId: ctx.user.id, externalIds: chosen });
    if (!result) target = `/integrations/tiktok/select/${encodeURIComponent(id)}`;
    else if (result.connected.length === 0 && result.conflicts.length === 0) target = `${ctx.base}?tt=cancelled`;
    else target = `${ctx.base}?${await finishTikTokConnection(db, ctx.pending.workspaceId, ctx.pending.clientId, result)}`;
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "tiktok_connect_failed", client: ctx.pending.clientId, code: d.code, error: d.message }));
    target = `${ctx.base}?e=tiktok&code=${encodeURIComponent(d.code)}`;
  }
  redirect(target);
}

/** Attach nothing; the token is deleted. */
export async function cancelConnection(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const ctx = await authorised(id);
  if (!ctx) redirect("/app");
  const db = serverDb();
  await cancelPendingConnection({ db, secrets: new VaultSecretStore(db) }, { id, userId: ctx.user.id });
  console.info(JSON.stringify({ event: "tiktok_connect_cancelled", client: ctx.pending.clientId }));
  redirect(`${ctx.base}?tt=cancelled`);
}
