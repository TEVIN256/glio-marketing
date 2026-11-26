import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { ACTIVITY_GROUPS, type ActivityGroup, actionsIn, describeAction } from "@/lib/activity";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";
import { requireUser } from "@/lib/supabase/server";
import { riyadhDateTime } from "@/lib/sync-status";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;

/** Workspace activity (owners and managers): the audit log, newest first, filterable by client and kind. */
export default async function ActivityPage({ params, searchParams }: {
  params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { ws } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const { supabase, user } = await requireUser();
  const { data: me } = await supabase.from("memberships").select("role").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle();
  if (!me || !["owner", "manager"].includes(me.role)) notFound();

  const client = q.c && UUID.test(q.c) ? q.c : null;
  const group = ACTIVITY_GROUPS.includes(q.k as ActivityGroup) ? (q.k as ActivityGroup) : null;
  const before = q.before && /^\d+$/.test(q.before) ? Number(q.before) : null;

  // Read under the user's own permissions: audit_log RLS lets only owners/managers of the workspace read it.
  let query = supabase.from("audit_log")
    .select("id, created_at, actor_kind, actor_user_id, actor_label, action, entity_type, entity_id, metadata")
    .eq("workspace_id", ws).order("id", { ascending: false }).limit(PAGE);
  if (group) query = query.in("action", actionsIn(group));
  if (client) query = query.or(`entity_id.eq.${client},metadata->>client_id.eq.${client}`);
  if (before) query = query.lt("id", before);
  const [{ data: rows }, { data: workspace }, { data: clients }] = await Promise.all([
    query,
    supabase.from("workspaces").select("name").eq("id", ws).maybeSingle(),
    supabase.from("clients").select("id, name").eq("workspace_id", ws).order("name"),
  ]);
  const entries = rows ?? [];
  const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  // Emails of the people in these rows (server read, after the role check above).
  const ids = [...new Set(entries.map((r) => r.actor_user_id).filter(Boolean))] as string[];
  const emails = new Map<string, string>(
    ids.length ? (await serverDb().query("select id, email from auth.users where id = any($1::uuid[])", [ids])).map((r) => [r.id, r.email]) : [],
  );
  const who = (r: (typeof entries)[number]) =>
    r.actor_kind === "user" ? (emails.get(r.actor_user_id as string) ?? t.activityFormerMember)
      : r.actor_label === "share-link" ? t.activityShareLink
      : r.actor_label === "unsubscribe-link" ? t.activityRecipient
      : `GLIO (${r.actor_label ?? r.actor_kind})`;
  const clientOf = (r: (typeof entries)[number]) => {
    const id = (r.metadata as Record<string, unknown> | null)?.client_id ?? (r.entity_type === "client" ? r.entity_id : null);
    return typeof id === "string" ? id : null;
  };
  const href = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { c: client, k: group, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/w/${ws}/activity${s ? `?${s}` : ""}`;
  };

  return (
    <div className="page">
      <PageHeader crumbs={[{ href: `/w/${ws}`, label: workspace?.name ?? t.workspaces }]} title={t.activityTitle} subtitle={t.activitySub} />
      <form className="activity-filters" method="get">
        <label htmlFor="c" className="sr-only">{t.clients}</label>
        <select id="c" name="c" defaultValue={client ?? ""}>
          <option value="">{t.activityAllClients}</option>
          {(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label htmlFor="k" className="sr-only">{t.activityKind}</label>
        <select id="k" name="k" defaultValue={group ?? ""}>
          <option value="">{t.activityAllKinds}</option>
          <option value="views">{t.activityViews}</option>
          <option value="changes">{t.activityChanges}</option>
          <option value="access">{t.activityAccess}</option>
        </select>
        <button type="submit" className="secondary">{t.apply}</button>
      </form>

      <section className="card">
        {entries.length === 0 ? <p className="muted">{t.activityNone}</p> : (
          <div className="table-wrap">
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t.activityWhen}</th><th scope="col">{t.activityWho}</th>
                <th scope="col">{t.activityWhat}</th><th scope="col">{t.activityClient}</th>
              </tr></thead>
              <tbody>
                {entries.map((r) => {
                  const cid = clientOf(r);
                  const snapshot = r.entity_type === "report_snapshot" && cid ? `/w/${ws}/c/${cid}/r/${r.entity_id}` : null;
                  return (
                    <tr key={r.id}>
                      <td><span className="num muted">{riyadhDateTime(r.created_at)}</span></td>
                      <td><bdi dir="ltr">{who(r)}</bdi></td>
                      <td>{snapshot && clientName.has(cid!) ? <a href={snapshot}>{describeAction(r.action, lang)}</a> : describeAction(r.action, lang)}</td>
                      <td>{cid ? (clientName.has(cid) ? <bdi>{clientName.get(cid)}</bdi> : <span className="muted">{t.activityDeletedClient}</span>) : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {entries.length === PAGE && <p><a href={href({ before: String(entries[entries.length - 1]!.id) })}>{t.activityOlder}</a></p>}
      </section>
      <p className="fine-print">{t.activityNote}</p>
    </div>
  );
}
