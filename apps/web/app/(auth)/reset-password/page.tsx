import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";
import { updatePassword } from "../login/actions";

/** Reached from the password reset link (signed in by it); also works for any signed-in person. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { t } = await getDict();
  const q = await searchParams;
  const { user } = await requireUser();
  const error = { weak: t.authWeak, mismatch: t.resetMismatch, same: t.resetSame, rate: t.authRate, auth: t.authError }[q.e ?? ""];

  return (
    <div className="auth stack">
      <h1>{t.resetTitle}</h1>
      <p className="muted">{t.resetSub} <span dir="ltr">{user.email}</span></p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <form className="card stack" action={updatePassword}>
        <div>
          <label htmlFor="new-password">{t.newPassword}</label>
          <input id="new-password" name="password" type="password" required minLength={8} autoComplete="new-password" dir="ltr" aria-describedby="np-hint" />
          <div id="np-hint" className="muted">{t.passwordHint}</div>
        </div>
        <div>
          <label htmlFor="confirm-password">{t.confirmPassword}</label>
          <input id="confirm-password" name="confirm" type="password" required minLength={8} autoComplete="new-password" dir="ltr" />
        </div>
        <button type="submit">{t.resetSave}</button>
      </form>
    </div>
  );
}
