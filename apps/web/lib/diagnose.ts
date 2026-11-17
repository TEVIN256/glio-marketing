import pg from "pg";
import { describeError } from "./errors";

/**
 * Explain DATABASE_URL without revealing it: which user/host/port/database
 * it points at, and only FACTS about the password (length, character
 * classes, placeholder left in). Then try a real connection. Never returns
 * the password or any part of it.
 */
export interface DbDiagnosis {
  present: boolean;
  parseError?: string;
  protocol?: string;
  user?: string;
  host?: string;
  port?: string;
  database?: string;
  pooler?: "transaction (6543)" | "session/direct (5432)" | "other";
  password?: {
    present: boolean;
    length: number;
    hasWhitespace: boolean;
    hasBrackets: boolean;
    hasPlaceholderText: boolean;
    hasNonAlphanumeric: boolean;
    percentEncoded: boolean;
  };
  hostLooksLikeSupabasePooler?: boolean;
  userLooksLikePoolerUser?: boolean;
  connection?: { ok: true; serverUser: string } | { ok: false; code: string; message: string };
}

export function inspectDatabaseUrl(raw: string | undefined): DbDiagnosis {
  if (!raw) return { present: false };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { present: true, parseError: "Not a valid URL (check for spaces, line breaks or a missing part)" };
  }
  const rawPassword = url.password;
  let password = rawPassword;
  try {
    password = decodeURIComponent(rawPassword);
  } catch {
    /* keep raw */
  }
  const user = decodeURIComponent(url.username);
  return {
    present: true,
    protocol: url.protocol.replace(":", ""),
    user,
    host: url.hostname,
    port: url.port || "(default 5432)",
    database: url.pathname.replace(/^\//, ""),
    pooler: url.port === "6543" ? "transaction (6543)" : url.port === "5432" || url.port === "" ? "session/direct (5432)" : "other",
    password: {
      present: password.length > 0,
      length: password.length,
      hasWhitespace: /\s/.test(raw) ,
      hasBrackets: /[[\]{}]/.test(password),
      hasPlaceholderText: /YOUR-PASSWORD|YOUR_PASSWORD|PASSWORD\]/i.test(raw),
      hasNonAlphanumeric: /[^A-Za-z0-9]/.test(password),
      percentEncoded: rawPassword.includes("%"),
    },
    hostLooksLikeSupabasePooler: /pooler\.supabase\.com$/.test(url.hostname),
    userLooksLikePoolerUser: /^postgres\.[a-z0-9]{20}$/.test(user),
  };
}

export async function diagnoseDatabase(raw: string | undefined): Promise<DbDiagnosis> {
  const d = inspectDatabaseUrl(raw);
  if (!d.present || d.parseError) return d;
  const client = new pg.Client({ connectionString: raw!.trim(), connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    const r = await client.query("select current_user as u");
    d.connection = { ok: true, serverUser: String(r.rows[0]?.u ?? "") };
  } catch (err) {
    const e = describeError(err);
    d.connection = { ok: false, code: e.code, message: e.message };
  } finally {
    await client.end().catch(() => {});
  }
  return d;
}
