import { switchLanguage } from "@/app/actions";
import { getDict } from "@/lib/i18n";

/** Sign-in and sign-up: brand panel + form. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { lang, t } = await getDict();
  return (
    <div className="auth-shell">
      <section className="auth-brand" aria-hidden="true">
        <a className="sidebar-brand" href="/">GLIO<span>.</span></a>
        <div>
          <p className="auth-brand-title">{t.authBrandTitle}</p>
          <p className="auth-brand-text">{t.authBrandText}</p>
        </div>
        <ul className="auth-points">
          <li>{t.authPoint1}</li>
          <li>{t.authPoint2}</li>
          <li>{t.authPoint3}</li>
        </ul>
      </section>
      <section className="auth-panel">
        <form action={switchLanguage} className="auth-lang">
          <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
          <button type="submit" className="secondary" lang={lang === "ar" ? "en" : "ar"}>{t.switchLang}</button>
        </form>
        <main className="auth-main">{children}</main>
      </section>
    </div>
  );
}
