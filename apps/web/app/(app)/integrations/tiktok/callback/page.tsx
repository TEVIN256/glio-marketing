import type { Metadata } from "next";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "TikTok · GLIO" };

/**
 * TikTok for Business OAuth redirect URL (registered in the TikTok developer portal):
 *   https://www.glioagency.org/integrations/tiktok/callback
 * TikTok returns here with ?auth_code=…&state=… after the advertiser approves.
 *
 * TODO(M6): verify `state` against the value stored when the flow started, exchange the
 * auth code with TikTokConnector.exchangeAuthCode (server-only, app secret from the
 * environment), store the token in the production secret store (not chosen yet, see
 * COMPLIANCE.md) and attach the authorized advertiser accounts to the client.
 * Until then this page only tells the user the connection isn't enabled; it never
 * logs, stores or echoes the auth code.
 */
export default async function TikTokCallbackPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser();
  const { lang } = await getDict();
  const q = await searchParams;
  const returned = Boolean(q.auth_code);
  const text = lang === "ar"
    ? {
        title: "ربط حساب تيك توك",
        body: returned
          ? "وصلنا ردّ تيك توك، لكن ربط الحسابات لم يُفعَّل بعد في غليو. لم يُحفظ أي شيء. سنخبرك عندما يصبح الربط متاحًا."
          : "ربط حسابات تيك توك للأعمال سيكون متاحًا قريبًا من صفحة العميل.",
        back: "العودة إلى مساحات العمل",
      }
    : {
        title: "Connect a TikTok account",
        body: returned
          ? "We received TikTok's response, but account connection isn't enabled in GLIO yet. Nothing was saved. We'll let you know when it's available."
          : "Connecting TikTok for Business accounts will be available soon from each client's page.",
        back: "Back to workspaces",
      };
  return (
    <div className="auth stack">
      <h1>{text.title}</h1>
      <p className="notice" role="status">{text.body}</p>
      <p><a href="/app">{text.back}</a></p>
    </div>
  );
}
