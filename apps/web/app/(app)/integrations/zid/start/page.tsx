import { connectZid } from "@/app/(app)/w/[ws]/c/[client]/actions";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

/**
 * The Zid app's "Redirection URL" (https://www.glioagency.org/integrations/zid/start): where Zid
 * sends a merchant after they install or activate GLIO from Zid. GLIO doesn't know yet which
 * client the store belongs to, so the person chooses; the button starts the normal read-only
 * connection (state cookie, Zid's permission page, callback). Only clients the person may
 * manage are offered; connectZid checks that again.
 */
export default async function ZidStart() {
  const { supabase, user } = await requireUser();
  const { t } = await getDict();
  const { data: roles } = await supabase.from("memberships").select("workspace_id, role").eq("user_id", user.id).in("role", ["owner", "manager"]);
  const wsIds = (roles ?? []).map((r) => r.workspace_id as string);
  const { data: clients } = wsIds.length
    ? await supabase.from("clients").select("id, name, workspace_id").in("workspace_id", wsIds).order("name")
    : { data: [] as Array<{ id: string; name: string; workspace_id: string }> };

  return (
    <div className="page">
      <section className="card stack">
        <h1>{t.zidStartTitle}</h1>
        <p className="muted">{t.zidStartHint}</p>
        {(clients ?? []).length === 0 ? (
          <p className="notice">{t.zidStartNoClients}</p>
        ) : (
          <ul className="list">
            {(clients ?? []).map((c) => (
              <li key={c.id} className="account-row">
                <span className="campaign-name">{c.name}</span>
                <form action={connectZid}>
                  <input type="hidden" name="ws" value={c.workspace_id} />
                  <input type="hidden" name="client" value={c.id} />
                  <button type="submit" className="secondary">{t.zidConnect}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p><a href="/app">{t.navHome}</a></p>
      </section>
    </div>
  );
}
