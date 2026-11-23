"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MoneyError, addDays, decimalToMinor, todayIn } from "@glio/core";
import { VaultSecretStore, executeApproval, suggestForClients, undoApproval } from "@glio/sync";
import { clientAccess } from "@/lib/authz";
import { describeError } from "@/lib/errors";
import { serverDb } from "@/lib/server-db";
import { requireUser } from "@/lib/supabase/server";

const UUID = /^[0-9a-f-]{36}$/i;

/** Back to the page the form was on (same origin, path only), with the result in the query. */
async function back(fallback: string, query: string): Promise<never> {
  let target = `${fallback}?${query}`;
  const ref = (await headers()).get("referer");
  if (ref) {
    try {
      const u = new URL(ref);
      for (const k of ["ap", "e", "code"]) u.searchParams.delete(k);
      for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
      target = `${u.pathname}?${u.searchParams.toString()}`;
    } catch {
      // keep the fallback
    }
  }
  redirect(target);
}

/** Propose a campaign change (owners, managers, analysts; RLS enforces it too). Nothing is executed here. */
export async function proposeChange(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const adAccount = String(formData.get("ad_account"));
  const campaignId = String(formData.get("campaign_id") ?? "").slice(0, 100);
  const campaignName = String(formData.get("campaign_name") ?? "").slice(0, 200) || null;
  const kind = String(formData.get("kind"));
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 1000) || null;
  const base = `/w/${ws}/c/${client}`;
  if (!UUID.test(ws) || !UUID.test(client) || !UUID.test(adAccount) || !campaignId) redirect(`${base}?e=approval&code=BAD_REQUEST`);
  if (!["campaign.pause", "campaign.enable", "campaign.budget"].includes(kind)) redirect(`${base}?e=approval&code=BAD_REQUEST`);

  const access = await clientAccess(ws, client);
  if (!access.canGenerate) redirect(`${base}?e=forbidden`);

  let payload: Record<string, string> = {};
  if (kind === "campaign.budget") {
    const { data: acct } = await access.supabase.from("ad_accounts").select("currency").eq("id", adAccount).maybeSingle();
    try {
      const minor = decimalToMinor(String(formData.get("budget") ?? "").trim().replace(/,/g, ""), acct?.currency ?? "SAR");
      if (minor <= 0n) throw new MoneyError("not positive");
      payload = { budget_minor: String(minor) };
    } catch {
      redirect(`${base}?e=budget#campaigns`);
    }
  }

  const { data, error } = await access.supabase.from("approval_requests").insert({
    workspace_id: ws, client_id: client, kind, payload, requested_by: access.user.id,
    ad_account_id: adAccount, target_type: "campaign", target_id: campaignId, target_name: campaignName, reason,
  }).select("id").single();
  if (error || !data) {
    console.error(JSON.stringify({ event: "approval_propose_failed", client, code: error?.code }));
    redirect(`${base}?e=approval&code=${encodeURIComponent(error?.code ?? "UNKNOWN")}#campaigns`);
  }
  await access.supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: access.user.id, action: "approval.requested",
    entity_type: "approval_request", entity_id: data.id, metadata: { kind, target_id: campaignId, client_id: client },
  });
  redirect(`${base}?ap=requested#campaigns`);
}

/** Approve (and immediately apply) or reject. The decision is made by decide_approval() under the user's own permissions. */
export async function decideApproval(formData: FormData) {
  const ws = String(formData.get("ws"));
  const id = String(formData.get("id"));
  const approve = formData.get("decision") === "approve";
  const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;
  const page = `/w/${ws}/approvals`;
  if (!UUID.test(id)) redirect(`${page}?e=approval&code=BAD_REQUEST`);
  const { supabase, user } = await requireUser();

  let outcome = "";
  try {
    const { data, error } = await supabase.rpc("decide_approval", { p_id: id, p_approve: approve, p_note: note });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    if (data === "approved") {
      // Allowed only because decide_approval() just confirmed this user is an owner/manager of the client.
      const db = serverDb();
      const result = await executeApproval({ db, secrets: new VaultSecretStore(db) }, { approvalId: id, executedBy: user.id });
      outcome = result.status === "executed" ? "ap=executed" : `e=approval&code=${encodeURIComponent(result.errorCode ?? "FAILED")}`;
    } else {
      outcome = `ap=${data}`;
    }
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "approval_decide_failed", id, code: d.code, error: d.message }));
    outcome = `e=approval&code=${encodeURIComponent(d.code)}`;
  }
  await back(page, outcome);
}

/** Undo an applied change (owners and managers of that client). */
export async function undoChange(formData: FormData) {
  const ws = String(formData.get("ws"));
  const id = String(formData.get("id"));
  const page = `/w/${ws}/approvals`;
  if (!UUID.test(id)) redirect(`${page}?e=approval&code=BAD_REQUEST`);
  const { supabase } = await requireUser();
  const { data: row } = await supabase.from("approval_requests").select("client_id").eq("id", id).maybeSingle();
  if (!row) redirect(`${page}?e=approval&code=APPROVAL_NOT_FOUND`);
  const access = await clientAccess(ws, row.client_id);
  if (!access.canManage) redirect(`${page}?e=forbidden`);

  let outcome = "";
  try {
    const db = serverDb();
    const result = await undoApproval({ db, secrets: new VaultSecretStore(db) }, { approvalId: id, userId: access.user.id });
    outcome = result.status === "executed" ? "ap=undone" : `e=approval&code=${encodeURIComponent(result.errorCode ?? "FAILED")}`;
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "approval_undo_failed", id, code: d.code, error: d.message }));
    outcome = `e=approval&code=${encodeURIComponent(d.code)}`;
  }
  await back(page, `tab=history&${outcome}`);
}

/** Save a client's safety limits (workspace owners; RLS enforces it too). */
export async function saveGuardrails(formData: FormData) {
  const ws = String(formData.get("ws"));
  const client = String(formData.get("client"));
  const base = `/w/${ws}/c/${client}`;
  const access = await clientAccess(ws, client);
  if (access.role !== "owner") redirect(`${base}?e=forbidden#guardrails`);
  const currency = String(formData.get("currency") || "SAR");
  const maxText = String(formData.get("max_daily_budget") ?? "").trim().replace(/,/g, "");
  let max: string | null = null;
  try {
    if (maxText) {
      const m = decimalToMinor(maxText, currency);
      if (m <= 0n) throw new MoneyError("not positive");
      max = String(m);
    }
  } catch {
    redirect(`${base}?e=budget#guardrails`);
  }
  const pct = Math.min(1000, Math.max(1, Math.round(Number(formData.get("max_increase_pct")) || 50)));
  const { error } = await access.supabase.from("client_guardrails").upsert(
    { client_id: client, workspace_id: ws, max_daily_budget_minor: max, max_budget_increase_pct: pct, updated_by: access.user.id, updated_at: new Date().toISOString() },
    { onConflict: "client_id" },
  );
  if (error) redirect(`${base}?e=approval&code=${encodeURIComponent(error.code ?? "UNKNOWN")}#guardrails`);
  await access.supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: access.user.id, action: "guardrails.updated",
    entity_type: "client", entity_id: client, metadata: { max_daily_budget_minor: max, max_budget_increase_pct: pct },
  });
  redirect(`${base}?ap=guardrails#guardrails`);
}

/**
 * Run GLIO's suggestion rules now for every client in the workspace
 * (owners and managers). Uses the stored data; nothing is applied.
 */
export async function checkSuggestions(formData: FormData) {
  const ws = String(formData.get("ws"));
  const page = `/w/${ws}/approvals`;
  if (!UUID.test(ws)) redirect("/app");
  const { supabase, user } = await requireUser();
  const { data: membership } = await supabase.from("memberships").select("role").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle();
  if (membership?.role !== "owner" && membership?.role !== "manager") redirect(`${page}?e=forbidden`);
  const { data: clients } = await supabase.from("clients").select("id").eq("workspace_id", ws);

  let outcome = "";
  try {
    // Allowed only because the user's owner/manager role in this workspace was just confirmed under RLS.
    const db = serverDb();
    const results = await suggestForClients(
      { db, secrets: new VaultSecretStore(db) },
      { clientIds: (clients ?? []).map((c) => c.id), yesterday: addDays(todayIn("Asia/Riyadh"), -1) },
    );
    const created = results.reduce((n, r) => n + r.created.length, 0);
    console.info(JSON.stringify({ event: "suggestions_checked", ws, created, errors: results.filter((r) => r.error).length }));
    // Why campaigns were not suggested (shown under the result), capped to keep the URL short.
    const skipped = results.flatMap((r) => r.skipped).slice(0, 12).map((k) => [String(k.name ?? k.campaignId).slice(0, 80), k.reason]);
    outcome = `sg=${created}` + (skipped.length ? `&sk=${Buffer.from(JSON.stringify(skipped)).toString("base64url")}` : "");
  } catch (err) {
    const d = describeError(err);
    console.error(JSON.stringify({ event: "suggestions_failed", ws, code: d.code, error: d.message }));
    outcome = `e=approval&code=${encodeURIComponent(d.code)}`;
  }
  redirect(`${page}?${outcome}`);
}

