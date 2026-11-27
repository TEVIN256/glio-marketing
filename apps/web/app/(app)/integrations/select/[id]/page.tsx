import { notFound } from "next/navigation";
import { loadPendingConnection } from "@glio/sync";
import { PageHeader } from "@/components/app/PageHeader";
import { clientAccess } from "@/lib/authz";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";
import { requireUser } from "@/lib/supabase/server";
import { riyadhDateTime } from "@/lib/sync-status";
import { cancelConnection, connectChosenAccounts } from "./actions";

// Connecting runs the first 30-day sync before redirecting.
export const maxDuration = 60;

/**
 * After TikTok's authorization granted several ad accounts: choose the ones that
 * belong to this client (ADR-032). Nothing is attached until the owner confirms.
 */
export default async function SelectTikTokAccounts({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireUser();
  const { lang, t } = await getDict();
  // Only the user who started the connection can load it (checked in the query), then their role on the client.
  const pending = await loadPendingConnection(serverDb(), { id, userId: user.id });

  if (!pending) {
    return (
      <div className="page">
        <section className="empty-state">
          <h1>{t.pickExpiredTitle}</h1>
          <p className="muted">{t.pickExpiredHint}</p>
          <p><a href="/app">{t.navHome}</a></p>
        </section>
      </div>
    );
  }
  const access = await clientAccess(pending.workspaceId, pending.clientId);
  if (!access.canManage || !access.client) notFound();

  const platformName = pending.platform === "snapchat" ? "Snapchat" : lang === "ar" ? "تيك توك" : "TikTok";
  const [before, after = ""] = t.pickSub.replace("{n}", String(pending.accounts.length)).replace("{platform}", platformName).split("{client}");
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ href: `/w/${pending.workspaceId}/c/${pending.clientId}`, label: access.client.name }]}
        title={t.pickTitle}
        subtitle={<>{before}<bdi>{access.client.name}</bdi>{after}</>}
      />
      <form className="card stack pick-form">
        <input type="hidden" name="id" value={pending.id} />
        <ul className="pick-list">
          {pending.accounts.map((a) => (
            <li key={a.externalId}>
              <label className={a.state === "other_client" ? "pick-row disabled" : "pick-row"}>
                <input type="checkbox" name="account" value={a.externalId}
                  defaultChecked={a.state === "this_client"} disabled={a.state === "other_client"} />
                <span>
                  <span className="campaign-name">{a.name ?? a.externalId}</span>
                  <span className="campaign-id" dir="ltr">{a.externalId}{a.currency ? ` · ${a.currency}` : ""}</span>
                </span>
                {a.state === "this_client" && <span className="badge ok">{t.pickThisClient}</span>}
                {a.state === "other_client" && (
                  <span className="badge other">{t.pickOtherClient} <bdi>{a.otherClientName}</bdi></span>
                )}
              </label>
            </li>
          ))}
        </ul>
        <p className="muted small">{pending.platform === "snapchat" ? t.pickNoteSnapchat : t.pickNote}</p>
        <div className="row-actions">
          <button type="submit" formAction={connectChosenAccounts}>{t.pickConnect}</button>
          <button type="submit" formAction={cancelConnection} className="secondary" formNoValidate>{t.pickCancel}</button>
        </div>
        <p className="fine-print">{t.pickExpires} <span className="num">{riyadhDateTime(pending.expiresAt.replace(" ", "T"))}</span></p>
      </form>
    </div>
  );
}
