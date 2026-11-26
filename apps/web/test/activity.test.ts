import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS, actionsIn, describeAction } from "@/lib/activity";

/** Every audit action GLIO writes has a label on the Activity page (so nothing shows up as raw code). */
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "test" || name === "dev-preview") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|sql)$/.test(name)) out.push(p);
  }
  return out;
}

describe("activity vocabulary", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const sources = [...files(join(root, "packages")), ...files(join(root, "apps/web/app")), ...files(join(root, "apps/web/lib")),
    ...files(join(root, "supabase/migrations"))].map((f) => readFileSync(f, "utf8")).join("\n");
  const written = new Set<string>();
  for (const m of sources.matchAll(/action: "([a-z_]+\.[a-z_]+)"/g)) written.add(m[1]!);
  for (const m of sources.matchAll(/insert into public\.audit_log[\s\S]{0,400}?'([a-z_]+\.[a-z_]+)'/g)) written.add(m[1]!);
  for (const m of sources.matchAll(/then '([a-z_]+\.[a-z_]+)' else '([a-z_]+\.[a-z_]+)'/g)) { written.add(m[1]!); written.add(m[2]!); }
  for (const m of sources.matchAll(/audit\([^)]*"([a-z_]+\.[a-z_]+)"/g)) written.add(m[1]!);

  it("finds the actions GLIO writes (sanity)", () => {
    for (const a of ["client.viewed", "report.viewed", "figure.viewed", "report.share_viewed", "ad_account.disconnected"]) expect(written).toContain(a);
  });

  it("every written action has an English and Arabic label", () => {
    const missing = [...written].filter((a) => !ACTIONS[a]);
    expect(missing).toEqual([]);
    expect(describeAction("report.viewed", "ar")).toBe("فتح تقريرًا");
    expect(describeAction("something.new", "en")).toBe("something.new");
  });

  it("views are the read actions", () => {
    expect(actionsIn("views").sort()).toEqual(["client.viewed", "figure.viewed", "report.share_viewed", "report.viewed"]);
  });
});
