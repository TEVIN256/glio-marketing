import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEmailLink } from "@/lib/email-link";
import { isPublicPath } from "@/proxy";

const template = (name: string) => readFileSync(new URL(`../../../supabase/templates/${name}`, import.meta.url), "utf8");

describe("Supabase Auth email links", () => {
  it("accepts only well-formed tokens and the three link types", () => {
    const hash = "a".repeat(56);
    expect(parseEmailLink(hash, "email")).toEqual({ tokenHash: hash, type: "email" });
    expect(parseEmailLink(hash, "recovery")).toEqual({ tokenHash: hash, type: "recovery" });
    expect(parseEmailLink(hash, "invite")).toBeNull();
    expect(parseEmailLink("short", "email")).toBeNull();
    expect(parseEmailLink(`${hash}"><script>`, "email")).toBeNull();
    expect(parseEmailLink(undefined, "email")).toBeNull();
  });

  it("the confirm page is reachable without signing in", () => {
    expect(isPublicPath("/auth/confirm")).toBe(true);
  });

  it.each([
    ["confirm-signup.html", "email"],
    ["reset-password.html", "recovery"],
  ])("%s links to /auth/confirm with the token hash (works in any browser), in Arabic and English", (file, type) => {
    const html = template(file);
    expect(html).toContain(`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}"`);
    expect(html).not.toContain("ConfirmationURL");
    expect(html).toContain('dir="rtl" lang="ar"');
    expect(html).toContain('dir="ltr" lang="en"');
    expect(html.match(/href="\{\{/g)).toHaveLength(2); // one button per language
  });
});
