import { accountDeletionBlockers } from "@glio/sync";
import { PageHeader } from "@/components/app/PageHeader";
import { env } from "@/lib/env";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";
import { requireUser } from "@/lib/supabase/server";
import { deleteMyAccount } from "./actions";

/** The signed-in person's own account: who they are, and deleting the account. */
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const { t } = await getDict();
  const { user } = await requireUser();
  // Server read of this person's own owner rows only (their id comes from the verified session).
  const blockers = await accountDeletionBlockers(serverDb(), user.id);

  return (
    <div className="page">
      <PageHeader title={t.accountTitle} subtitle={<bdi dir="ltr">{user.email}</bdi>} />
      {q.e === "confirm" && <p className="notice error" role="alert">{t.accountConfirmError}</p>}
      {q.e === "sole_owner" && <p className="notice error" role="alert">{t.accountSoleOwner}</p>}
      {q.e === "not_configured" && <p className="notice error" role="alert">{t.accountNotConfigured}</p>}
      {q.e === "delete" && <p className="notice error" role="alert">{t.accountDeleteError} {q.code && <code className="num">({q.code})</code>}</p>}

      <section id="delete-account" className="card stack danger-card" aria-labelledby="delete-account-h">
        <h2 id="delete-account-h">{t.accountDeleteTitle}</h2>
        <p>{t.accountDeleteText}</p>
        <p className="muted">{t.accountDeleteKept}</p>
        {blockers.length > 0 ? (
          <div className="notice warn">
            <p style={{ margin: 0 }}>{t.accountBlocked}</p>
            <ul>
              {blockers.map((b) => (
                <li key={b.id}><a href={`/w/${b.id}/team#delete-ws`}><bdi>{b.name}</bdi></a>{b.members > 1 ? ` · ${t.accountBlockedMembers.replace("{n}", String(b.members - 1))}` : ""}</li>
              ))}
            </ul>
          </div>
        ) : !env.accountDeletionConfigured() ? (
          <p className="notice">{t.accountNotConfigured}</p>
        ) : (
          <form action={deleteMyAccount} className="delete-form">
            <label htmlFor="confirm-email">{t.accountConfirm} <strong><bdi dir="ltr">{user.email}</bdi></strong></label>
            <input id="confirm-email" name="confirm" type="email" required autoComplete="off" dir="ltr" />
            <button type="submit" className="danger">{t.accountDeleteButton}</button>
          </form>
        )}
      </section>
    </div>
  );
}
