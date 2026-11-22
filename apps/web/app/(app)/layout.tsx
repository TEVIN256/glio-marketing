import { Sidebar, type SidebarWorkspace } from "@/components/app/Sidebar";
import { getDict } from "@/lib/i18n";
import { site } from "@/lib/site";
import { supabaseAsUser } from "@/lib/supabase/server";

/**
 * The signed-in product: navy sidebar (workspaces and clients, read under the
 * user's own permissions) and a light content area.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { lang, t } = await getDict();
  const s = site[lang];
  const supabase = await supabaseAsUser();
  const { data: auth } = await supabase.auth.getUser();
  let workspaces: SidebarWorkspace[] = [];
  if (auth.user) {
    const [{ data: ws }, { data: clients }, { data: pending }] = await Promise.all([
      supabase.from("workspaces").select("id, name").order("created_at"),
      supabase.from("clients").select("id, name, workspace_id").order("name"),
      supabase.from("approval_requests").select("workspace_id, expires_at").eq("status", "pending"),
    ]);
    const now = Date.now();
    workspaces = (ws ?? []).map((w) => ({
      id: w.id, name: w.name,
      clients: (clients ?? []).filter((c) => c.workspace_id === w.id).map((c) => ({ id: c.id, name: c.name })),
      pendingApprovals: (pending ?? []).filter((p) => p.workspace_id === w.id && (!p.expires_at || new Date(p.expires_at).getTime() > now)).length,
    }));
  }
  return (
    <div className="app-shell">
      <Sidebar
        lang={lang}
        email={auth.user?.email ?? ""}
        workspaces={workspaces}
        labels={{
          home: t.navHome, workspaces: t.workspaces, clients: t.clients, allClients: t.navAllClients,
          switchLang: t.switchLang, signOut: t.signOut, website: t.navWebsite, approvals: t.navApprovals,
        }}
      />
      <div className="app-main">
        <main>{children}</main>
        <footer className="app-footer">
          <a href="/privacy">{s.navPrivacy}</a> · <a href="/terms">{s.navTerms}</a>
        </footer>
      </div>
    </div>
  );
}
