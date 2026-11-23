import { getDict } from "@/lib/i18n";
import { safeNext } from "@/lib/safe-next";
import { signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { t } = await getDict();
  const q = await searchParams;
  const signup = q.mode === "signup";
  const next = safeNext(q.next);
  const withNext = (path: string) => (next === "/app" ? path : `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`);

  return (
    <div className="auth stack">
      <h1>{signup ? t.signUp : t.signIn}</h1>
      <p className="muted">{t.tagline}</p>
      {next.startsWith("/invite/") && <p className="notice" role="status">{t.inviteSignInHint}</p>}
      {q.m === "check" && <p className="notice" role="status">{t.checkEmail}</p>}
      {q.e === "auth" && <p className="notice error" role="alert">{t.authError}</p>}
      {q.e === "signup" && <p className="notice error" role="alert">{t.signUpError}</p>}

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
      </form>

      <p>
        {signup ? t.haveAccount : t.noAccount}{" "}
        <a href={withNext(signup ? "/login" : "/login?mode=signup")}>{signup ? t.signIn : t.signUp}</a>
      </p>
    </div>
  );
}
