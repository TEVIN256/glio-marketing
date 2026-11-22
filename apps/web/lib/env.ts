/**
 * Environment access. Values are read when used (not at import), so the app
 * builds without secrets present.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see apps/web/.env.example)`);
  return value;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabasePublishableKey: () => required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  /** SERVER ONLY: direct Postgres connection for server-side writes. */
  databaseUrl: () => required("DATABASE_URL"),
  anthropicConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  demoMode: () => process.env.GLIO_DEMO_MODE === "1",
  /** TikTok Marketing API app (developer portal). The secret is SERVER ONLY. */
  tiktokAppId: () => required("TIKTOK_APP_ID"),
  tiktokAppSecret: () => required("TIKTOK_APP_SECRET"),
  tiktokConfigured: () => Boolean(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET),
  /** Must match the "Advertiser redirect URL" registered with TikTok exactly. */
  tiktokRedirectUri: () => process.env.TIKTOK_REDIRECT_URI || "https://www.glioagency.org/integrations/tiktok/callback",
  /** Report emails (Resend). The key is SERVER ONLY. */
  resendApiKey: () => process.env.RESEND_API_KEY ?? "",
  emailConfigured: () => Boolean(process.env.RESEND_API_KEY),
  reportsFrom: () => process.env.REPORTS_FROM || "GLIO Reports <reports@glioagency.org>",
  reportsReplyTo: () => process.env.REPORTS_REPLY_TO || "info@glioagency.org",
  appUrl: () => (process.env.APP_URL || "https://www.glioagency.org").replace(/\/$/, ""),
  /** Vercel sends it as "Authorization: Bearer <CRON_SECRET>" to cron routes. SERVER ONLY. */
  cronSecret: () => process.env.CRON_SECRET ?? "",
};
