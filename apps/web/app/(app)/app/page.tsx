import { redirect } from "next/navigation";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";

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
  const { supabase, user } = await requireUser();
  const q = await searchParams;
  const { data: workspaces } = await supabase.from("workspaces").select("id, name, kind, created_at").order("created_at");

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{t.workspaces}</h1>
        <form action={signOut}>
          <span className="muted" dir="ltr">{user.email}</span>{" "}
          <button className="secondary" type="submit">{t.signOut}</button>
        </form>
      </div>

      {workspaces && workspaces.length > 0 && (
        <ul className="list card">
          {workspaces.map((w) => (
            <li key={w.id}>
              <a href={`/w/${w.id}`}>{w.name}</a>{" "}
              <span className="muted">· {w.kind === "agency" ? t.kindAgency : t.kindBusiness}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>{t.createWorkspace}</h2>
      {q.e && <p className="notice error" role="alert">{t.createError}</p>}
      <form className="card stack" action={createWorkspace}>
        <div>
          <label htmlFor="ws-name">{t.workspaceName}</label>
          <input id="ws-name" name="name" required maxLength={200} />
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600 }}>{t.workspaceKind}</legend>
          <label style={{ fontWeight: 400 }}>
            <input type="radio" name="kind" value="business" defaultChecked style={{ minWidth: 0 }} /> {t.kindBusiness}
          </label>
          <label style={{ fontWeight: 400 }}>
            <input type="radio" name="kind" value="agency" style={{ minWidth: 0 }} /> {t.kindAgency}
          </label>
        </fieldset>
        <button type="submit">{t.create}</button>
      </form>
    </div>
  );
}
