import { COMPANY, type SiteText } from "@/lib/site";

export function SiteFooter({ lang, s }: { lang: "ar" | "en"; s: SiteText }) {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="site-footer">
      <nav aria-label={s.navHome} className="footer-links">
        <a href="/">{s.navHome}</a>
        <a href="/privacy">{s.navPrivacy}</a>
        <a href="/terms">{s.navTerms}</a>
        <a href={`mailto:${COMPANY.email}`} dir="ltr">{COMPANY.email}</a>
      </nav>
      <p className="muted">
        © <span className="num">{year}</span> {lang === "ar" ? COMPANY.tradeNameAr : COMPANY.tradeNameEn} ·{" "}
        {lang === "ar" ? COMPANY.legalNameAr : COMPANY.legalNameEn} · {COMPANY.country[lang]}
        {COMPANY.crNumber && (
          <>
            {" "}· {s.contactCr} <span className="num">{COMPANY.crNumber}</span>
          </>
        )}{" "}
        · {s.footerRights}
      </p>
    </footer>
  );
}
