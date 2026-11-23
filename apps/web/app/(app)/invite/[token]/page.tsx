import { PageHeader } from "@/components/app/PageHeader";
import { getDict } from "@/lib/i18n";
import { hashInviteToken, isInviteToken } from "@/lib/invite-token";
import { requireUser } from "@/lib/supabase/server";
import { acceptInvite, switchAccount } from "./actions";

/** What an invite link opens: who invited you to what, and a Join button. Nothing happens until Join. */
export default async function InvitePage({
  params, searchParams,
}: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const q = await searchParams;
  const { t } = await getDict();
  const { supabase, user } = await requireUser();

  const valid = isInviteToken(token);
  const { data } = valid
    ? await supabase.rpc("invitation_preview", { p_token_hash: hashInviteToken(token) })
    : { data: null };
  const inv = (data as Array<{ workspace_name: string; role: string; client_name: string | null; invited_email: string; status: string }> | null)?.[0];
  const role = inv ? ({ manager: t.roleManager, analyst: t.roleAnalyst, client_viewer: t.roleClientViewer }[inv.role] ?? inv.role) : "";

  return (
    <div className="page invite-page">
      <PageHeader title={t.inviteTitle} />
      {!inv ? (
        <section className="empty-state"><h2>{t.inviteNotFound}</h2></section>
      ) : (
        <section className="card stack">
          <p className="invite-what">
            {t.inviteJoinLine.replace("{role}", role)} <strong><bdi>{inv.workspace_name}</bdi></strong>
            {inv.client_name && <> · <bdi>{inv.client_name}</bdi></>}
          </p>
          {q.e && <p className="notice error" role="alert">{t.inviteAcceptError}</p>}
          {inv.status === "open" && (
            <form action={acceptInvite}>
              <input type="hidden" name="token" value={token} />
              <button type="submit">{t.inviteJoin}</button>
            </form>
          )}
          {inv.status === "wrong_account" && (
            <>
              <p className="notice warn">
                {t.inviteWrongAccount.replace("{invited}", inv.invited_email).replace("{me}", user.email ?? "")}
              </p>
              <form action={switchAccount}>
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="secondary">{t.inviteSwitchAccount}</button>
              </form>
            </>
          )}
          {inv.status === "accepted" && <p className="notice">{t.inviteAlreadyUsed} <a href="/app">{t.workspaces}</a></p>}
          {(inv.status === "expired" || inv.status === "revoked") && <p className="notice warn">{t.inviteNoLongerValid}</p>}
        </section>
      )}
    </div>
  );
}
