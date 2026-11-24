import type { Metadata } from "next";
import { findUnsubscribeLink } from "@glio/reports";
import { switchLanguage } from "@/app/actions";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";
import { resubscribeAction, unsubscribeAction } from "./actions";

// The URL carries the link's secret: not indexed, never sent as a referrer.
export const metadata: Metadata = { title: "GLIO", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Unsubscribe page, from the link at the bottom of a report email. Opening it
 * changes nothing (email scanners open links); the button does. Mail apps'
 * own "Unsubscribe" button uses the one-click endpoint (/api/unsubscribe).
 */
export default async function UnsubscribePage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const link = await findUnsubscribeLink(serverDb(), token);
  const withClient = (text: string) => {
    const [before, after] = text.split("{client}");
    return <>{before}<bdi>{link?.clientName}</bdi>{after}</>;
  };

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
        <section className="card stack unsub-card">
          {!link ? (
            <>
              <h1>{t.unsubInvalid}</h1>
              <p className="muted">{t.unsubInvalidHint}</p>
            </>
          ) : link.unsubscribed ? (
            <>
              <h1>{t.unsubTitle}</h1>
              <p className="notice" role="status">{withClient(t.unsubDone)}</p>
              <p className="muted"><bdi dir="ltr">{link.email}</bdi></p>
              <form action={resubscribeAction} className="row">
                <input type="hidden" name="token" value={token} />
                <span className="muted">{t.unsubUndoHint}</span>
                <button type="submit" className="secondary">{t.resubButton}</button>
              </form>
            </>
          ) : (
            <>
              <h1>{t.unsubTitle}</h1>
              {q.done === "resub" && <p className="notice" role="status">{t.resubDone}</p>}
              <p>{withClient(t.unsubQuestion)}</p>
              <p><strong><bdi dir="ltr">{link.email}</bdi></strong></p>
              <form action={unsubscribeAction}>
                <input type="hidden" name="token" value={token} />
                <button type="submit">{t.unsubButton}</button>
              </form>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
