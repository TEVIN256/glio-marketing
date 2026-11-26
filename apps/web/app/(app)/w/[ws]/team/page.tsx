import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { ERROR_HINTS } from "@/lib/errors";
import { getDict } from "@/lib/i18n";
import { INVITE_LINK_COOKIE } from "@/lib/invite-token";
import { serverDb } from "@/lib/server-db";
import { requireUser } from "@/lib/supabase/server";
import { changeRole, inviteMember, removeMember, revokeInvite, deleteWorkspace } from "./actions";

const fmt = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

/** The workspace team: members and roles (owners/managers), invites and changes (owners only). */
export default async function TeamPage({
  params, searchParams,
}: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const { supabase, user } = await requireUser();

  const [{ data: workspace }, { data: me }] = await Promise.all([
    supabase.from("workspaces").select("id, name").eq("id", ws).maybeSingle(),
    supabase.from("memberships").select("role").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle(),
  ]);
  if (!workspace || !me) notFound();
  const isOwner = me.role === "owner";
  const canSeeTeam = isOwner || me.role === "manager";

  // RLS decides which memberships this person may see (owners/managers: all; others: only their own).
  const [{ data: members }, { data: clients }, { data: invites }] = await Promise.all([
    supabase.from("memberships").select("user_id, role, client_id, created_at").eq("workspace_id", ws).order("created_at"),
    supabase.from("clients").select("id, name").eq("workspace_id", ws).order("name"),
    isOwner
      ? supabase.from("invitations").select("id, email, role, client_id, created_at, expires_at, accepted_at, revoked_at")
          .eq("workspace_id", ws).order("created_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as Array<{ id: string; email: string; role: string; client_id: string | null; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }> }),
  ]);
  // Emails are not readable by users; look up only the members RLS already showed.
  const ids = (members ?? []).map((m) => m.user_id);
  const emails = new Map<string, string>(
    ids.length ? (await serverDb().query("select id, email from auth.users where id = any($1::uuid[])", [ids])).map((r) => [r.id, r.email]) : [],
  );
  const clientName = (id: string | null) => clients?.find((c) => c.id === id)?.name ?? "";
  const roleLabel = (role: string, clientId: string | null) =>
    ({ owner: t.roleOwner, manager: t.roleManager, analyst: t.roleAnalyst, client_viewer: t.roleClientViewer }[role] ?? role)
    + (clientId ? ` · ${clientName(clientId)}` : "");
  const now = Date.now();
  const openInvites = (invites ?? []).filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at).getTime() > now);
  const newLink = isOwner ? (await cookies()).get(INVITE_LINK_COOKIE)?.value : undefined;

  const roleOptions = (
    <>
      <option value="manager">{t.roleManager}</option>
      <option value="analyst">{t.roleAnalyst}</option>
      {(clients ?? []).map((c) => <option key={c.id} value={`client_viewer:${c.id}`}>{t.roleClientViewer}: {c.name}</option>)}
    </>
  );

  return (
    <div className="page">
      <PageHeader crumbs={[{ href: "/app", label: t.workspaces }, { href: `/w/${ws}`, label: workspace.name }]} title={t.teamTitle} subtitle={t.teamSub} />

      {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
      {q.e === "ws_confirm" && <p className="notice error" role="alert">{t.deleteWsConfirmError}</p>}
      {q.e === "ws_delete" && <p className="notice error" role="alert">{t.deleteWsError} {q.code && <code className="num">({q.code})</code>}</p>}
      {q.e === "invite_input" && <p className="notice error" role="alert">{t.inviteInputError}</p>}
      {q.e === "invite" && (
        <p className="notice error" role="alert">{t.inviteError} {q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null} {q.code && <code className="num">({q.code})</code>}</p>
      )}
      {q.invited !== undefined && (
        <div className="notice" role="status">
          <p style={{ margin: 0 }}>{q.invited === "1" ? t.invitedSent : t.invitedNoEmail}</p>
          {newLink && (
            <p style={{ margin: "8px 0 0" }}>
              {t.inviteLinkLabel} <input className="invite-link" readOnly value={newLink} dir="ltr" aria-label={t.inviteLinkLabel} />
            </p>
          )}
        </div>
      )}
      {q.done && { revoked: t.doneRevoked, role: t.doneRole, removed: t.doneRemoved }[q.done] && (
        <p className="notice" role="status">{{ revoked: t.doneRevoked, role: t.doneRole, removed: t.doneRemoved }[q.done]}</p>
      )}

      {isOwner && (
        <section className="card stack" aria-labelledby="invite-h">
          <div className="card-head"><h2 id="invite-h">{t.inviteTitleCard}</h2></div>
          <form className="invite-form" action={inviteMember}>
            <input type="hidden" name="ws" value={ws} />
            <div>
              <label htmlFor="invite-email">{t.email}</label>
              <input id="invite-email" name="email" type="email" required dir="ltr" placeholder="name@company.com" />
            </div>
            <div>
              <label htmlFor="invite-role">{t.roleLabel}</label>
              <select id="invite-role" name="role" defaultValue="analyst">{roleOptions}</select>
            </div>
            <button type="submit">{t.inviteSend}</button>
          </form>
          <ul className="role-help muted">
            <li><strong>{t.roleManager}:</strong> {t.roleManagerHelp}</li>
            <li><strong>{t.roleAnalyst}:</strong> {t.roleAnalystHelp}</li>
            <li><strong>{t.roleClientViewer}:</strong> {t.roleClientViewerHelp}</li>
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="members-h">
        <div className="card-head"><h2 id="members-h">{t.membersTitle}</h2></div>
        {!canSeeTeam && <p className="muted">{t.teamOnlyOwners}</p>}
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th scope="col">{t.email}</th><th scope="col">{t.roleLabel}</th><th scope="col"><span className="sr-only">{t.actions}</span></th></tr></thead>
            <tbody>
              {(members ?? []).map((m) => (
                <tr key={m.user_id}>
                  <th scope="row">
                    <span dir="ltr">{emails.get(m.user_id) ?? "—"}</span>
                    {m.user_id === user.id && <span className="muted"> ({t.requestedByYou})</span>}
                  </th>
                  <td>{roleLabel(m.role, m.client_id)}</td>
                  <td className="n">
                    {isOwner && m.user_id !== user.id && m.role !== "owner" && (
                      <div className="member-actions">
                        <form action={changeRole}>
                          <input type="hidden" name="ws" value={ws} />
                          <input type="hidden" name="user" value={m.user_id} />
                          <label className="sr-only" htmlFor={`role-${m.user_id}`}>{t.roleLabel}</label>
                          <select id={`role-${m.user_id}`} name="role" defaultValue={m.role === "client_viewer" ? `client_viewer:${m.client_id}` : m.role}>{roleOptions}</select>
                          <button type="submit" className="secondary">{t.save}</button>
                        </form>
                        <form action={removeMember}>
                          <input type="hidden" name="ws" value={ws} />
                          <input type="hidden" name="user" value={m.user_id} />
                          <button type="submit" className="secondary danger">{t.removeMember}</button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isOwner && (invites ?? []).length > 0 && (
        <section className="card" aria-labelledby="invites-h">
          <div className="card-head"><h2 id="invites-h">{t.invitesTitle}</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <tbody>
                {(invites ?? []).map((i) => {
                  const open = openInvites.includes(i);
                  const status = i.accepted_at ? t.inviteAccepted : i.revoked_at ? t.inviteRevoked : open ? t.invitePending : t.inviteExpired;
                  return (
                    <tr key={i.id}>
                      <th scope="row"><span dir="ltr">{i.email}</span></th>
                      <td>{roleLabel(i.role, i.client_id)}</td>
                      <td><span className={`badge ${i.accepted_at ? "ok" : open ? "drift" : "other"}`}>{status}</span></td>
                      <td className="muted"><span className="num">{fmt(i.created_at)}</span></td>
                      <td className="n">
                        {open && (
                          <form action={revokeInvite}>
                            <input type="hidden" name="ws" value={ws} />
                            <input type="hidden" name="id" value={i.id} />
                            <button type="submit" className="secondary">{t.inviteCancel}</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isOwner && (
        <section id="delete-ws" className="card stack danger-card" aria-labelledby="delete-ws-h">
          <h2 id="delete-ws-h">{t.deleteWsTitle}</h2>
          <p>{t.deleteWsText}</p>
          <p className="muted">{t.deleteWsKept}</p>
          <form action={deleteWorkspace} className="delete-form">
            <input type="hidden" name="ws" value={ws} />
            <label htmlFor="delete-ws-confirm">{t.deleteWsConfirm} <strong><bdi>{workspace.name}</bdi></strong></label>
            <input id="delete-ws-confirm" name="confirm" required autoComplete="off" />
            <button type="submit" className="danger">{t.deleteWsButton}</button>
          </form>
        </section>
      )}
    </div>
  );
}
