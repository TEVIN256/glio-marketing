import { describe, expect, it } from "vitest";
import { renderInviteEmail } from "@/lib/invite-email";
import { hashInviteToken, isInviteToken, newInviteToken } from "@/lib/invite-token";

describe("invite tokens", () => {
  it("are random, URL-safe, and only their SHA-256 is stored", () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(isInviteToken(a.token)).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashInviteToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });
  it("anything that isn't a token is rejected before the database", () => {
    for (const bad of ["", "abc", "../../etc", "a".repeat(44), "x".repeat(42) + "!"]) expect(isInviteToken(bad)).toBe(false);
  });
});

describe("invite email", () => {
  const base = { workspaceName: "Test Agency A", role: "client_viewer" as const, clientName: "Test Client A1", inviterEmail: "owner@example.test", link: "https://www.example.test/invite/TOKEN", contactEmail: "info@example.test" };
  it("is Arabic first, then English, with role, client, inviter and the link", () => {
    const e = renderInviteEmail(base);
    const plain = e.html.replace(/<[^>]+>/g, "");
    expect(e.html.indexOf('dir="rtl"')).toBeLessThan(e.html.indexOf('dir="ltr"'));
    expect(plain).toContain("مشاهد لعميل");
    expect(plain).toContain("as Client viewer for the client “Test Client A1”");
    expect(plain).toContain("owner@example.test invited you");
    expect(e.html).toContain('href="https://www.example.test/invite/TOKEN"');
    expect(e.subject).toContain("Invitation to join Test Agency A");
  });
  it("escapes names and keeps the subject on one line", () => {
    const e = renderInviteEmail({ ...base, workspaceName: "<script>x</script>\r\nBcc: y@example.test", clientName: '"><img src=x>' });
    expect(e.html).not.toContain("<script>x</script>");
    expect(e.html).not.toContain("<img src=x>");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });
});
