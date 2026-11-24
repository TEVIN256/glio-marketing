"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SHARE_DAYS_ALLOWED, createShare } from "@glio/reports";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { SHARE_LINK_COOKIE } from "@/lib/invite-token";
import { serverDb } from "@/lib/server-db";

const UUID = /^[0-9a-f-]{36}$/i;

/** Create a read-only share link for this report (owners and managers). Shown once to the creator. */
export async function createShareLink(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const snapshot = String(formData.get("snapshot"));
  const page = `/w/${ws}/c/${client}/r/${snapshot}`;
  if (!UUID.test(snapshot)) redirect(`/w/${ws}/c/${client}`);
  const access = await clientAccess(ws, client);
  if (!access.canManage) redirect(`${page}?e=forbidden#share`);
  // The snapshot must be one this user can see, for this client (RLS).
  const { data: snap } = await access.supabase.from("report_snapshots").select("id").eq("id", snapshot).eq("client_id", client).maybeSingle();
  if (!snap) redirect(`/w/${ws}/c/${client}`);
  const days = Number(formData.get("days"));

  let ok = false;
  try {
    // Allowed only after the owner/manager check above; created_by records who made it.
    const share = await createShare(serverDb(), {
      snapshotId: snapshot, days: (SHARE_DAYS_ALLOWED as readonly number[]).includes(days) ? days : undefined, createdBy: access.user.id,
    });
    await access.supabase.from("audit_log").insert({
      workspace_id: ws, actor_kind: "user", actor_user_id: access.user.id, action: "report.shared",
      entity_type: "report_share", entity_id: share.id, metadata: { snapshot_id: snapshot, expires_at: share.expiresAt },
    });
    (await cookies()).set(SHARE_LINK_COOKIE, `${env.appUrl()}/s/${share.token}`, {
      httpOnly: true, secure: true, sameSite: "lax", path: page, maxAge: 300,
    });
    ok = true;
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "share_create_failed", snapshot, code: d.code }));
  }
  redirect(`${page}?${ok ? "shared=1" : "e=share"}#share`);
}

/** Revoke a share link (owners and managers; RLS allows changing only revoked_at). */
export async function revokeShareLink(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const snapshot = String(formData.get("snapshot"));
  const id = String(formData.get("id"));
  const page = `/w/${ws}/c/${client}/r/${snapshot}`;
  const access = await clientAccess(ws, client);
  if (!access.canManage || !UUID.test(id)) redirect(`${page}?e=forbidden#share`);
  await access.supabase.from("report_shares").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("client_id", client).is("revoked_at", null);
  await access.supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: access.user.id, action: "report.share_revoked", entity_type: "report_share", entity_id: id,
  });
  redirect(`${page}?revoked=1#share`);
}
