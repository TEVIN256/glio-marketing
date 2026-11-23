import { notFound, redirect } from "next/navigation";
import { DEMO_EXTERNAL_ID } from "@glio/connectors";
import { PageHeader } from "@/components/app/PageHeader";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

async function addClient(formData: FormData) {
  "use server";
  const { supabase } = await requireUser();
  const ws = String(formData.get("ws"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect(`/w/${ws}`);
  // RLS allows this only for the workspace's owners and managers.
  const { data, error } = await supabase.from("clients").insert({ workspace_id: ws, name }).select("id").single();
  if (error || !data) redirect(`/w/${ws}?e=forbidden`);
  redirect(`/w/${ws}/c/${data.id}`);
}

export default async function WorkspacePage({
  params, searchParams,
}: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws } = await params;
  const q = await searchParams;
  const { t } = await getDict();
  const { supabase } = await requireUser();

  const { data: workspace } = await supabase.from("workspaces").select("id, name, kind").eq("id", ws).maybeSingle();
  if (!workspace) notFound();
  const [{ data: clients }, { data: accounts }, { data: snapshots }] = await Promise.all([
    supabase.from("clients").select("id, name").eq("workspace_id", ws).order("created_at"),
    supabase.from("ad_accounts").select("client_id, external_id, status").eq("workspace_id", ws).eq("platform", "tiktok"),
    supabase.from("report_snapshots").select("client_id, date_from, date_to, created_at").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(200),
  ]);

  // A business has exactly one client (itself): go straight to its dashboard.
  if (workspace.kind === "business" && clients?.length === 1) redirect(`/w/${ws}/c/${clients[0]!.id}`);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ href: "/app", label: t.workspaces }]}
        title={workspace.name}
        subtitle={t.clientsSub}
      />
      {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
      {q.joined && <p className="notice" role="status">{t.joinedNotice}</p>}

      <div className="tile-grid">
        {(clients ?? []).map((c) => {
          const n = (accounts ?? []).filter((a) => a.client_id === c.id && a.external_id !== DEMO_EXTERNAL_ID).length;
          const last = (snapshots ?? []).find((s) => s.client_id === c.id);
          return (
            <a key={c.id} className="tile" href={`/w/${ws}/c/${c.id}`}>
              <span className="tile-avatar" aria-hidden="true">{c.name.trim().charAt(0).toUpperCase()}</span>
              <span className="tile-title">{c.name}</span>
              <span className="tile-meta">{t.accountsCount.replace("{n}", String(n))}</span>
              <span className="tile-meta">
                {t.lastReport}: {last ? <span className="num">{last.date_from} → {last.date_to}</span> : t.noReportYet}
              </span>
              <span className="tile-cta">{t.openDashboard} <span aria-hidden="true" className="flip">→</span></span>
            </a>
          );
        })}

        {workspace.kind === "agency" && (
          <form className="tile tile-form" action={addClient}>
            <input type="hidden" name="ws" value={ws} />
            <span className="tile-avatar add" aria-hidden="true">+</span>
            <label htmlFor="client-name" className="tile-title">{t.addClient}</label>
            <input id="client-name" name="name" required maxLength={200} placeholder={t.clientName} />
            <button type="submit">{t.add}</button>
          </form>
        )}
      </div>
      {(!clients || clients.length === 0) && workspace.kind !== "agency" && <p className="muted">{t.noClients}</p>}
    </div>
  );
}
