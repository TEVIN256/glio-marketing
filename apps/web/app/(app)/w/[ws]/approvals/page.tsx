import { notFound } from "next/navigation";
import { type ApprovalListRow, ApprovalsView } from "@/components/app/ApprovalsView";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

/** Every change proposed for this workspace's campaigns: decide pending ones, review and undo applied ones. */
export default async function ApprovalsPage({
  params, searchParams,
}: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const { supabase, user } = await requireUser();

  const [{ data: workspace }, { data: membership }] = await Promise.all([
    supabase.from("workspaces").select("id, name").eq("id", ws).maybeSingle(),
    supabase.from("memberships").select("role").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle(),
  ]);
  if (!workspace) notFound();
  const canDecide = membership?.role === "owner" || membership?.role === "manager";
  const tab = q.tab === "history" ? "history" : "pending";

  const [{ data: rows }, { data: clients }, { data: accounts }] = await Promise.all([
    supabase.from("approval_requests")
      .select("id, client_id, kind, payload, status, requested_by, requested_by_agent, reason, target_name, target_id, ad_account_id, before_state, after_state, created_at, decided_at, decision_note, executed_at, error_code, expires_at, undo_of")
      .eq("workspace_id", ws).order("created_at", { ascending: false }).limit(200),
    supabase.from("clients").select("id, name").eq("workspace_id", ws),
    supabase.from("ad_accounts").select("id, currency").eq("workspace_id", ws),
  ]);
  return (
    <ApprovalsView
      ws={ws} workspaceName={workspace.name} rows={(rows ?? []) as ApprovalListRow[]} clients={clients ?? []} accounts={accounts ?? []}
      userId={user.id} canDecide={canDecide} tab={tab} q={q} lang={lang} t={t}
    />
  );
}
