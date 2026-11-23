"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ResendMailer, normalizeRecipients } from "@glio/reports";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { renderInviteEmail } from "@/lib/invite-email";
import { INVITE_LINK_COOKIE, newInviteToken } from "@/lib/invite-token";
import { requireUser } from "@/lib/supabase/server";

const UUID = /^[0-9a-f-]{36}$/i;

/** Only owners manage the team (RLS enforces it too). */
async function ownerOf(ws: string) {
  if (!UUID.test(ws)) redirect("/app");
  const { supabase, user } = await requireUser();
  const { data: m } = await supabase.from("memberships").select("role").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle();
  if (m?.role !== "owner") redirect(`/w/${ws}/team?e=forbidden`);
  return { supabase, user };
}

/** Role and client from the form: "manager", "analyst", or "client_viewer:<client id>". */
function parseRole(value: unknown): { role: "manager" | "analyst" | "client_viewer"; clientId: string | null } | null {
  const v = String(value ?? "");
  if (v === "manager" || v === "analyst") return { role: v, clientId: null };
  const m = v.match(/^client_viewer:([0-9a-f-]{36})$/i);
  return m ? { role: "client_viewer", clientId: m[1]! } : null;
}

export async function inviteMember(formData: FormData) {
  const ws = String(formData.get("ws"));
  const page = `/w/${ws}/team`;
  const { supabase, user } = await ownerOf(ws);
  const { valid } = normalizeRecipients(String(formData.get("email") ?? ""));
  const role = parseRole(formData.get("role"));
  if (valid.length !== 1 || !role) redirect(`${page}?e=invite_input`);
  const email = valid[0]!;

  const { token, hash } = newInviteToken();
  // A new invite to the same email replaces an open one.
  await supabase.from("invitations").update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", ws).eq("email", email).is("accepted_at", null).is("revoked_at", null);
  const { data: inv, error } = await supabase.from("invitations").insert({
    workspace_id: ws, email, role: role.role, client_id: role.clientId, token_hash: hash, invited_by: user.id,
  }).select("id").single();
  if (error || !inv) redirect(`${page}?e=invite&code=${encodeURIComponent(error?.code ?? "UNKNOWN")}`);
  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "member.invited",
    entity_type: "invitation", entity_id: inv.id, metadata: { role: role.role, client_id: role.clientId },
  });

  const link = `${env.appUrl()}/invite/${token}`;
  // Shown once to the owner (to copy/share), kept out of URLs and logs.
  (await cookies()).set(INVITE_LINK_COOKIE, link, { httpOnly: true, secure: true, sameSite: "lax", path: page, maxAge: 300 });

  let sent = "0";
  if (env.emailConfigured()) {
    try {
      const [{ data: w }, { data: c }] = await Promise.all([
        supabase.from("workspaces").select("name").eq("id", ws).maybeSingle(),
        role.clientId ? supabase.from("clients").select("name").eq("id", role.clientId).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const mail = renderInviteEmail({
        workspaceName: w?.name ?? "", role: role.role, clientName: c?.name ?? null, inviterEmail: user.email ?? "",
        link, contactEmail: env.reportsReplyTo(),
      });
      await new ResendMailer(env.resendApiKey()).send({
        from: env.reportsFrom(), to: email, replyTo: user.email ?? env.reportsReplyTo(), ...mail, idempotencyKey: `glio-invite-${inv.id}`,
      });
      sent = "1";
    } catch (err) {
      const d = describeError(err);
      console.error(JSON.stringify({ event: "invite_email_failed", ws, code: d.code }));
    }
  }
  redirect(`${page}?invited=${sent}`);
}

export async function revokeInvite(formData: FormData) {
  const ws = String(formData.get("ws"));
  const id = String(formData.get("id"));
  const { supabase, user } = await ownerOf(ws);
  if (!UUID.test(id)) redirect(`/w/${ws}/team`);
  await supabase.from("invitations").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("workspace_id", ws).is("accepted_at", null);
  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "member.invite_revoked", entity_type: "invitation", entity_id: id,
  });
  redirect(`/w/${ws}/team?done=revoked`);
}

export async function changeRole(formData: FormData) {
  const ws = String(formData.get("ws"));
  const member = String(formData.get("user"));
  const { supabase, user } = await ownerOf(ws);
  const role = parseRole(formData.get("role"));
  if (!UUID.test(member) || !role || member === user.id) redirect(`/w/${ws}/team?e=forbidden`);
  const { error, data } = await supabase.from("memberships").update({ role: role.role, client_id: role.clientId })
    .eq("workspace_id", ws).eq("user_id", member).neq("role", "owner").select("user_id");
  if (error || !data?.length) redirect(`/w/${ws}/team?e=forbidden`);
  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "member.role_changed",
    entity_type: "user", entity_id: member, metadata: { role: role.role, client_id: role.clientId },
  });
  redirect(`/w/${ws}/team?done=role`);
}

export async function removeMember(formData: FormData) {
  const ws = String(formData.get("ws"));
  const member = String(formData.get("user"));
  const { supabase, user } = await ownerOf(ws);
  if (!UUID.test(member) || member === user.id) redirect(`/w/${ws}/team?e=forbidden`);
  const { error, data } = await supabase.from("memberships").delete()
    .eq("workspace_id", ws).eq("user_id", member).neq("role", "owner").select("user_id");
  if (error || !data?.length) redirect(`/w/${ws}/team?e=forbidden`);
  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "member.removed", entity_type: "user", entity_id: member,
  });
  redirect(`/w/${ws}/team?done=removed`);
}
