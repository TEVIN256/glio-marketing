import { redirect } from "next/navigation";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";
import { PageHeader } from "@/components/app/PageHeader";

async function createWorkspace(formData: FormData) {
  "use server";
  const { supabase } = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const kind = formData.get("kind") === "agency" ? "agency" : "business";
  if (!name) redirect("/app?e=name");
  // create_workspace() makes the caller the owner and writes the audit entry.
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name, p_kind: kind });
  if (error || !data) redirect("/app?e=create");
  redirect(`/w/${data}`);
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { t } = await getDict();
  const { supabase } = await requireUser();
  const q = await searchParams;
  const [{ data: workspaces }, { data: clients }] = await Promise.all([
    supabase.from("workspaces").select("id, name, kind, created_at").order("created_at"),
    supabase.from("clients").select("id, workspace_id"),
  ]);

  return (
    <div className="page">
      <PageHeader title={t.welcome} subtitle={t.workspacesSub} />
      {q.pw === "changed" && <p className="notice" role="status">{t.pwChanged}</p>}
      {q.e && <p className="notice error" role="alert">{q.e === "tiktok_state" ? t.tiktokStateError : t.createError}</p>}

      <div className="tile-grid">
        {(workspaces ?? []).map((w) => (
          <a key={w.id} className="tile" href={`/w/${w.id}`}>
            <span className="tile-avatar" aria-hidden="true">{w.name.trim().charAt(0).toUpperCase()}</span>
            <span className="tile-title">{w.name}</span>
            <span className={`badge ${w.kind === "agency" ? "ok" : "other"}`}>{w.kind === "agency" ? t.kindAgency : t.kindBusiness}</span>
            <span className="tile-meta">{t.clientsCount.replace("{n}", String((clients ?? []).filter((c) => c.workspace_id === w.id).length))}</span>
            <span className="tile-cta">{t.openDashboard} <span aria-hidden="true" className="flip">→</span></span>
          </a>
        ))}

        <form className="tile tile-form" action={createWorkspace}>
          <span className="tile-avatar add" aria-hidden="true">+</span>
          <label htmlFor="ws-name" className="tile-title">{t.createWorkspace}</label>
          <input id="ws-name" name="name" required maxLength={200} placeholder={t.workspaceName} />
          <fieldset className="choice">
            <legend className="sr-only">{t.workspaceKind}</legend>
            <label><input type="radio" name="kind" value="business" defaultChecked /> {t.kindBusiness}</label>
            <label><input type="radio" name="kind" value="agency" /> {t.kindAgency}</label>
          </fieldset>
          <button type="submit">{t.create}</button>
        </form>
      </div>
    </div>
  );
}
