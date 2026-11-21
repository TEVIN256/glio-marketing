import { notFound, redirect } from "next/navigation";
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
  const { data: clients } = await supabase.from("clients").select("id, name").eq("workspace_id", ws).order("created_at");

  // A business has exactly one client (itself): go straight to its dashboard.
  if (workspace.kind === "business" && clients?.length === 1) redirect(`/w/${ws}/c/${clients[0]!.id}`);

  return (
    <div className="stack">
      <p><a href="/app">← {t.workspaces}</a></p>
      <h1>{workspace.name}</h1>
      <h2>{t.clients}</h2>
      {clients && clients.length > 0 ? (
        <ul className="list card">
          {clients.map((c) => (
            <li key={c.id}><a href={`/w/${ws}/c/${c.id}`}>{c.name}</a></li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t.noClients}</p>
      )}

      {workspace.kind === "agency" && (
        <>
          <h2>{t.addClient}</h2>
          {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
          <form className="card row" action={addClient}>
            <input type="hidden" name="ws" value={ws} />
            <div>
              <label htmlFor="client-name">{t.clientName}</label>
              <input id="client-name" name="name" required maxLength={200} />
            </div>
            <button type="submit">{t.add}</button>
          </form>
        </>
      )}
    </div>
  );
}
