import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A "use client" module runs in the browser. Server code may render its
 * components, but calling one of its plain functions on the server crashes the
 * page ("Attempted to call X() from the server but X is on the client").
 * So client modules may export only components (Capitalized) and types.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("client/server boundary", () => {
  const root = join(import.meta.dirname, "..");
  const clientModules = [...files(join(root, "components")), ...files(join(root, "app"))]
    .filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

  it("finds the client modules", () => {
    expect(clientModules.length).toBeGreaterThan(0);
  });

  it("client modules export only components and types", () => {
    const offenders: string[] = [];
    for (const f of clientModules) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
        if (!/^[A-Z]/.test(m[1]!)) offenders.push(`${f.replace(root, "")}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
