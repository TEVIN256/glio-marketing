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
};
