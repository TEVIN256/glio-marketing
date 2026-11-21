import { switchLanguage } from "@/app/actions";
import { SiteFooter } from "@/components/SiteFooter";
import { getLang } from "@/lib/i18n";
import { site } from "@/lib/site";

/** Public website (glioagency.org): dark theme, marketing header and footer. */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  const s = site[lang];
  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="site-brand" href="/" aria-label="GLIO">GLIO<span aria-hidden="true">.</span></a>
        <nav className="site-nav" aria-label={s.navHome}>
          <a href="/#services">{s.navServices}</a>
          <a href="/#platform">{s.navPlatform}</a>
          <a href="/#demo">{s.navDemo}</a>
        </nav>
        <div className="site-actions">
          <form action={switchLanguage}>
            <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
            <button className="ghost" type="submit" lang={lang === "ar" ? "en" : "ar"}>{s.switchLang}</button>
          </form>
          <a className="button outline" href="/app">{s.signIn}</a>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <SiteFooter lang={lang} s={s} />
    </div>
  );
}
