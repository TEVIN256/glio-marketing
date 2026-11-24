import type { Metadata } from "next";
import { openShare } from "@glio/reports";
import { switchLanguage } from "@/app/actions";
import { ReportView } from "@/components/ReportView";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";

// Shared links are private: not indexed, and the URL (which carries the secret) is never sent as a referrer.
export const metadata: Metadata = { title: "GLIO", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** A report opened through a share link: read-only, no GLIO account needed. */
export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { lang, t } = await getDict();
  const shared = await openShare(serverDb(), token);

  return (
    <div className="shared-shell">
      <header className="shared-header">
        <span className="sidebar-brand">GLIO<span>.</span></span>
        <form action={switchLanguage}>
          <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
          <button type="submit" className="ghost" lang={lang === "ar" ? "en" : "ar"}>{t.switchLang}</button>
        </form>
      </header>
      <main className="shared-main">
        {shared ? (
          <div className="page report-page">
            <header className="page-header">
              <div>
                <p className="crumbs">{t.sharedReport}</p>
                <h1><bdi>{shared.clientName}</bdi> · <span className="num">{shared.report.period.from} → {shared.report.period.to}</span></h1>
                <p className="page-sub">
                  {t.sharedValidUntil} <span className="num">{shared.expiresAt.slice(0, 10)}</span>
                </p>
              </div>
            </header>
            <ReportView report={shared.report} commentary={shared.commentary} lang={lang} t={t} />
            <p className="fine-print">{t.sharedFooter}</p>
          </div>
        ) : (
          <section className="empty-state">
            <h1>{t.sharedUnavailable}</h1>
            <p className="muted">{t.sharedUnavailableHint}</p>
          </section>
        )}
      </main>
    </div>
  );
}
