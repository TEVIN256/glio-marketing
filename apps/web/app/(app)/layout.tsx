import { switchLanguage } from "@/app/actions";
import { getDict } from "@/lib/i18n";
import { site } from "@/lib/site";

/** The signed-in product (and sign-in pages): light theme, compact top bar. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { lang, t } = await getDict();
  const s = site[lang];
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/app">{t.appName}</a>
        <div className="topbar-actions">
          <form action={switchLanguage}>
            <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
            <button className="secondary" type="submit" lang={lang === "ar" ? "en" : "ar"}>{t.switchLang}</button>
          </form>
        </div>
      </header>
      <main>{children}</main>
      <footer className="app-footer muted">
        <a href="/">{s.navHome}</a> · <a href="/privacy">{s.navPrivacy}</a> · <a href="/terms">{s.navTerms}</a>
      </footer>
    </>
  );
}
