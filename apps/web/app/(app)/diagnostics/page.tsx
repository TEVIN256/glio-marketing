import { notFound } from "next/navigation";
import { diagnoseDatabase } from "@/lib/diagnose";
import { serverDb } from "@/lib/server-db";
import { type Check, runSystemChecks } from "@/lib/system-check";
import { requireUser } from "@/lib/supabase/server";

/**
 * Setup diagnostics for workspace owners: a live system check (configuration,
 * schema, Vault, TikTok, recent failures), then the database connection
 * settings. Shows no secret values.
 */
export const dynamic = "force-dynamic";

export default async function Diagnostics() {
  const { supabase, user } = await requireUser();
  const { data: owned } = await supabase.from("memberships").select("workspace_id").eq("user_id", user.id).eq("role", "owner").limit(1);
  if (!owned || owned.length === 0) notFound();

  const d = await diagnoseDatabase(process.env.DATABASE_URL);
  let checks: Check[];
  try {
    checks = d.connection?.ok ? await runSystemChecks(serverDb()) : [];
  } catch (err) {
    checks = [{ group: "System check", name: "Could not finish", status: "bad", detail: err instanceof Error ? err.message.slice(0, 200) : "error" }];
  }
  const icon = (s: Check["status"]) => (s === "ok" ? "✅" : s === "bad" ? "❌" : s === "warn" ? "⚠️" : "ℹ️");
  const groups = [...new Set(checks.map((c) => c.group))];
  const problems = checks.filter((c) => c.status === "bad").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const yes = (b: boolean | undefined) => (b ? "yes" : "no");
  const rows: Array<[string, string, "ok" | "bad" | "info"]> = [];
  rows.push(["DATABASE_URL set", yes(d.present), d.present ? "ok" : "bad"]);
  if (d.parseError) rows.push(["Readable", d.parseError, "bad"]);
  if (d.present && !d.parseError) {
    rows.push(["Protocol", d.protocol ?? "", d.protocol === "postgresql" || d.protocol === "postgres" ? "ok" : "bad"]);
    rows.push(["User", d.user ?? "", d.userLooksLikePoolerUser ? "ok" : "bad"]);
    rows.push(["Host", d.host ?? "", d.hostLooksLikeSupabasePooler ? "ok" : "bad"]);
    rows.push(["Port", `${d.port} (${d.pooler})`, d.pooler === "transaction (6543)" ? "ok" : "bad"]);
    rows.push(["Database", d.database ?? "", d.database === "postgres" ? "ok" : "bad"]);
    const p = d.password!;
    rows.push(["Password present", yes(p.present), p.present ? "ok" : "bad"]);
    rows.push(["Password length", String(p.length), p.length >= 12 ? "info" : "bad"]);
    rows.push(["Spaces or line breaks anywhere", yes(p.hasWhitespace), p.hasWhitespace ? "bad" : "ok"]);
    rows.push(["Brackets [ ] { } in password", yes(p.hasBrackets), p.hasBrackets ? "bad" : "ok"]);
    rows.push(["Placeholder text left (YOUR-PASSWORD)", yes(p.hasPlaceholderText), p.hasPlaceholderText ? "bad" : "ok"]);
    rows.push(["Symbols in password", yes(p.hasNonAlphanumeric), p.hasNonAlphanumeric ? "bad" : "ok"]);
    if (d.connection) {
      rows.push(d.connection.ok
        ? ["Connection test", `connected as ${d.connection.serverUser}`, "ok"]
        : ["Connection test", `failed (${d.connection.code}): ${d.connection.message}`, "bad"]);
    }
  }

  return (
    <div className="stack" dir="ltr" lang="en">
      <h1>Setup diagnostics</h1>
      {checks.length > 0 && (
        <p className={problems ? "notice error" : warnings ? "notice warn" : "notice"} role="status">
          {problems ? `${problems} problem(s) found` : warnings ? `No problems; ${warnings} thing(s) to look at` : "All checks passed"}
        </p>
      )}
      {groups.map((g) => (
        <section key={g} className="stack">
          <h2>{g}</h2>
          <table className="card" style={{ borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              {checks.filter((c) => c.group === g).map((c) => (
                <tr key={c.name} style={{ borderBlockEnd: "1px solid var(--line)" }}>
                  <td style={{ padding: 8, fontWeight: 600, width: "40%" }}>{icon(c.status)} {c.name}</td>
                  <td style={{ padding: 8 }}><code>{c.detail}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <h2>Database connection settings</h2>
      <p className="muted">No secret values are shown; the password is described, never displayed.</p>
      <table className="card" style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {rows.map(([k, v, s]) => (
            <tr key={k} style={{ borderBlockEnd: "1px solid var(--line)" }}>
              <td style={{ padding: 8, fontWeight: 600 }}>{s === "ok" ? "✅" : s === "bad" ? "❌" : "ℹ️"} {k}</td>
              <td style={{ padding: 8 }}><code>{v}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
