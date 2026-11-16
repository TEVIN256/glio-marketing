import pg from "pg";
import { type SqlExecutor, pgExecutor } from "@glio/sync";
import { env } from "./env";

/**
 * SERVER ONLY. A direct Postgres connection with server privileges, used for
 * writes that users may not make themselves (report snapshots, syncs).
 * It bypasses row-level security, so every caller MUST first check the
 * user's permission through `supabaseAsUser()` (see lib/authz.ts).
 * Never import this from a Client Component.
 */

let pool: pg.Pool | null = null;

export function serverDb(): SqlExecutor {
  pool ??= new pg.Pool({ connectionString: env.databaseUrl(), max: 5 });
  return pgExecutor(pool);
}
