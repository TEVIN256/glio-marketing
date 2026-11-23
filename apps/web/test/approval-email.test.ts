import { describe, expect, it } from "vitest";
import type { PendingItem } from "@glio/reports";
import { renderApprovalEmail } from "@/lib/approval-email";

const item = (over: Partial<PendingItem>): PendingItem => ({
  id: "00000000-0000-4000-8000-000000000001", workspace_id: "w1", client_id: "c1", client_name: "Test Client A1", kind: "campaign.pause",
  payload: {}, reason: "CPA too high (synthetic)", target_name: "Demo Campaign C", target_id: "demo-campaign-c", currency: "SAR",
  requested_by: "u1", requested_by_agent: null, created_at: "2026-11-23 10:00:00+00", ...over,
});
const suggestion = item({
  id: "00000000-0000-4000-8000-000000000002", kind: "campaign.budget", requested_by: null, requested_by_agent: "glio-rules/v1",
  target_name: "Demo Campaign D (strong)", reason: "English fallback",
  payload: { budget_minor: "18000", evidence: { rule: "raise_budget_low_cpa", version: 1, window: { from: "2026-11-16", to: "2026-11-22" },
    currency: "SAR", spend_minor: "52526", conversions: "157", cpa_minor: "335", client_cpa_minor: "1110", current_budget_minor: "15000", new_budget_minor: "18000" } },
});
const render = (items: PendingItem[], workspaceName = "Test Agency A") =>
  renderApprovalEmail({ workspaceId: "w1", workspaceName, items, appUrl: "https://www.example.test/", contactEmail: "info@example.test" });

describe("approvals notification email", () => {
  it("is Arabic first, then English, and lists every request in plain words", () => {
    const e = render([item({}), suggestion]);
    expect(e.html.indexOf('dir="rtl"')).toBeLessThan(e.html.indexOf('dir="ltr"'));
    expect(e.html).toContain("إيقاف الحملة «Demo Campaign C»");
    expect(e.html).toContain("Pause campaign “Demo Campaign C”");
    const plain = e.html.replace(/<[^>]+>/g, "");
    expect(plain).toContain("Set the daily budget of “Demo Campaign D (strong)” to SAR 180.00");
    expect(plain).toContain("from SAR 150.00 to SAR 180.00");
    expect(e.html.replace(/<[^>]+>/g, "")).toContain("180.00 ر.س");
    expect(e.html).toContain('<span dir="ltr" style="unicode-bidi:isolate">2026-11-16</span>');
    expect(e.html).not.toContain("English fallback");
    expect(e.html).toContain("<bdi>Test Agency A</bdi>");
    expect(e.text).toContain("https://www.example.test/w/w1/approvals");
  });

  it("has a one-line subject with the count and the workspace", () => {
    const e = render([item({}), suggestion], "Test Agency A\r\nBcc: x@example.test");
    expect(e.subject).toContain("2 waiting for your approval");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });

  it("escapes names and reasons", () => {
    const e = render([item({ client_name: "<b>Evil</b>", reason: '<img src=x onerror="alert(1)">' })]);
    expect(e.html).not.toContain("<b>Evil</b>");
    expect(e.html).not.toContain("<img src=x");
    expect(e.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });
});
