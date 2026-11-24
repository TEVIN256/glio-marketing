import type { Metadata } from "next";
import { parseEmailLink } from "@/lib/email-link";
import { getDict } from "@/lib/i18n";
import { confirmEmailLink } from "./actions";

// The URL carries a one-time token: keep it out of search engines and referrers.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Landing page for links in sign-up and password reset emails: one button, then the token is used. */
export default async function ConfirmEmailLinkPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { t } = await getDict();
  const q = await searchParams;
  const link = parseEmailLink(q.token_hash, q.type);

  if (!link) {
    return (
      <div className="auth stack">
        <h1>{t.confirmInvalidTitle}</h1>
        <p className="notice error" role="alert">{t.authLinkExpired}</p>
        <p><a href="/login">{t.backToSignIn}</a></p>
      </div>
    );
  }
  const recovery = link.type === "recovery";
  return (
    <div className="auth stack">
      <h1>{recovery ? t.confirmTitleRecovery : t.confirmTitleSignup}</h1>
      <p className="muted">{t.confirmSub}</p>
      <form className="card stack" action={confirmEmailLink}>
        <input type="hidden" name="token_hash" value={link.tokenHash} />
        <input type="hidden" name="type" value={link.type} />
        <button type="submit">{recovery ? t.confirmButtonRecovery : t.confirmButtonSignup}</button>
      </form>
    </div>
  );
}
