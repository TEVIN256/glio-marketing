import { getDict } from "@/lib/i18n";
import { signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { t } = await getDict();
  const q = await searchParams;
  const signup = q.mode === "signup";

  return (
    <div className="auth stack">
      <h1>{signup ? t.signUp : t.signIn}</h1>
      <p className="muted">{t.tagline}</p>
      {q.m === "check" && <p className="notice" role="status">{t.checkEmail}</p>}
      {q.e === "auth" && <p className="notice error" role="alert">{t.authError}</p>}
      {q.e === "signup" && <p className="notice error" role="alert">{t.signUpError}</p>}

      <form className="card stack" action={signup ? signUp : signIn}>
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
        <a href={signup ? "/login" : "/login?mode=signup"}>{signup ? t.signIn : t.signUp}</a>
      </p>
    </div>
  );
}
