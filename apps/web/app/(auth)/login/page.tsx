import { cookies } from "next/headers";
import { getDict } from "@/lib/i18n";
import { NEXT_COOKIE, safeNext } from "@/lib/safe-next";
import { requestPasswordReset, resendConfirmation, signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { t } = await getDict();
  const q = await searchParams;
  const signup = q.mode === "signup";
  const forgot = q.mode === "forgot";
  // Where to go after signing in: the page asked for, or (after a confirmation link) the one remembered at sign-up.
  const next = safeNext(q.next ?? (await cookies()).get(NEXT_COOKIE)?.value);
  const withNext = (path: string) => (next === "/app" ? path : `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`);

  if (forgot) {
    return (
      <div className="auth stack">
        <h1>{t.forgotTitle}</h1>
        <p className="muted">{t.forgotSub}</p>
        {q.m === "reset_sent" && <p className="notice" role="status">{t.resetSent}</p>}
        {q.e === "email" && <p className="notice error" role="alert">{t.inviteInputError}</p>}
        {q.e === "rate" && <p className="notice error" role="alert">{t.authRate}</p>}
        {q.e === "expired" && <p className="notice error" role="alert">{t.resetExpired}</p>}
        <form className="card stack" action={requestPasswordReset}>
          <div>
            <label htmlFor="forgot-email">{t.email}</label>
            <input id="forgot-email" name="email" type="email" autoComplete="email" required dir="ltr" />
          </div>
          <button type="submit">{t.forgotSend}</button>
        </form>
        <p><a href="/login">{t.backToSignIn}</a></p>
      </div>
    );
  }

  return (
    <div className="auth stack">
      <h1>{signup ? t.signUp : t.signIn}</h1>
      <p className="muted">{t.tagline}</p>
      {next.startsWith("/invite/") && <p className="notice" role="status">{t.inviteSignInHint}</p>}
      {q.m === "check" && <p className="notice" role="status">{t.checkEmail}</p>}
      {q.m === "account_deleted" && <p className="notice" role="status">{t.accountDeletedNotice}</p>}
      {(q.m === "confirmed" || q.m === "link") && <p className="notice" role="status">{t.authLinkOtherBrowser}</p>}
      {q.e === "auth" && <p className="notice error" role="alert">{t.authError}</p>}
      {q.e === "link" && <p className="notice error" role="alert">{t.authLinkExpired}</p>}
      {q.e === "credentials" && <p className="notice error" role="alert">{t.authCredentials}</p>}
      {q.e === "rate" && <p className="notice error" role="alert">{t.authRate}</p>}
      {q.e === "exists" && <p className="notice error" role="alert">{t.authExists} <a href={withNext("/login")}>{t.signIn}</a></p>}
      {q.e === "weak" && <p className="notice error" role="alert">{t.authWeak}</p>}
      {q.e === "signup" && <p className="notice error" role="alert">{t.signUpError}</p>}
      {q.e === "unconfirmed" && (
        <div className="notice warn" role="alert">
          <p style={{ margin: 0 }}>{t.authUnconfirmed}</p>
          <form className="resend-form" action={resendConfirmation}>
            <input type="hidden" name="next" value={next} />
            <label className="sr-only" htmlFor="resend-email">{t.email}</label>
            <input id="resend-email" name="email" type="email" required dir="ltr" placeholder={t.email} />
            <button type="submit" className="secondary">{t.authResend}</button>
          </form>
        </div>
      )}

      <form className="card stack" action={signup ? signUp : signIn}>
        <input type="hidden" name="next" value={next} />
        <div>
          <label htmlFor="email">{t.email}</label>
          <input id="email" name="email" type="email" autoComplete="email" required dir="ltr" />
        </div>
        <div>
          <label htmlFor="password">{t.password}</label>
          <input
            id="password" name="password" type="password" required minLength={8} dir="ltr"
            autoComplete={signup ? "new-password" : "current-password"} aria-describedby="pw-hint"
          />
          <div id="pw-hint" className="muted">{t.passwordHint}</div>
        </div>
        <button type="submit">{signup ? t.signUp : t.signIn}</button>
        {!signup && <a className="forgot-link" href="/login?mode=forgot">{t.forgotLink}</a>}
      </form>

      <p>
        {signup ? t.haveAccount : t.noAccount}{" "}
        <a href={withNext(signup ? "/login" : "/login?mode=signup")}>{signup ? t.signIn : t.signUp}</a>
      </p>
    </div>
  );
}
