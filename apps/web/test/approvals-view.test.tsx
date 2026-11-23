import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type ApprovalListRow, ApprovalsView } from "@/components/app/ApprovalsView";
import { dict } from "@/lib/i18n";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const base: ApprovalListRow = {
  id: "00000000-0000-4000-8000-000000000001", client_id: "c1", kind: "campaign.budget", payload: { budget_minor: "12000" },
  status: "pending", requested_by: "u-analyst", requested_by_agent: null, reason: "CPA too high (synthetic)", target_name: "Demo Campaign B",
  target_id: "demo-campaign-b", ad_account_id: "a1", before_state: null, after_state: null, created_at: "2026-11-22T10:00:00Z",
  decided_at: null, decision_note: null, executed_at: null, error_code: null, expires_at: "2026-11-29T10:00:00Z", undo_of: null,
};
const executed: ApprovalListRow = {
  ...base, id: "00000000-0000-4000-8000-000000000002", kind: "campaign.pause", payload: {}, status: "executed",
  before_state: { status: "ENABLE", budgetMinor: "15000" }, after_state: { status: "DISABLE", budgetMinor: "15000" }, executed_at: "2026-11-21T09:00:00Z",
};
const failed: ApprovalListRow = { ...base, id: "00000000-0000-4000-8000-000000000003", status: "failed", error_code: "GUARDRAIL_MAX_INCREASE" };
const render = (props: Partial<Parameters<typeof ApprovalsView>[0]>) => renderToStaticMarkup(
  <ApprovalsView ws="ws1" workspaceName="Test Agency A" rows={[base, executed, failed]} clients={[{ id: "c1", name: "Test Client A1" }]}
    accounts={[{ id: "a1", currency: "SAR" }]} userId="u-owner" canDecide tab="pending" q={{}} lang="en" t={dict.en} now={NOW} {...props} />,
);

describe("ApprovalsView", () => {
  it("lists pending requests in plain words with approve and reject for owners/managers", () => {
    const html = render({});
    expect(html).toContain("Set the daily budget of “Demo Campaign B” to SAR 120.00");
    expect(html).toContain("CPA too high (synthetic)");
    expect(html).toContain(dict.en.approveBudget); // the pending request is a budget change
    expect(html).toContain(dict.en.reject);
    expect(html).not.toContain("Pause campaign"); // executed one is in history, not pending
  });

  it("others see that an owner or manager must approve", () => {
    const html = render({ canDecide: false });
    expect(html).not.toContain(dict.en.approveBudget);
    expect(html).toContain(dict.en.waitingForApprover);
  });

  it("history shows before and after, the failure reason, and Undo only for applied changes", () => {
    const html = render({ tab: "history" });
    expect(html).toContain("On · SAR 150.00");
    expect(html).toContain("Paused · SAR 150.00");
    expect(html).toContain("above the per-change limit");
    expect(html.match(new RegExp(`>${dict.en.undo}</button>`, "g"))).toHaveLength(1);
    expect(render({ tab: "history", canDecide: false })).not.toContain(`>${dict.en.undo}</button>`);
  });

  it("an expired pending request is not offered for approval", () => {
    const html = render({ rows: [{ ...base, expires_at: "2026-11-22T11:00:00Z" }] });
    expect(html).toContain(dict.en.noPending);
  });
});

describe("GLIO suggestions in the approvals view", () => {
  const suggestion: ApprovalListRow = {
    ...base, id: "00000000-0000-4000-8000-000000000009", requested_by: null, requested_by_agent: "glio-rules/v1",
    kind: "campaign.budget", target_name: "Demo Campaign D (strong)",
    payload: { budget_minor: "18000", evidence: {
      rule: "raise_budget_low_cpa", version: 1, window: { from: "2026-11-10", to: "2026-11-16" }, currency: "SAR",
      spend_minor: "71234", conversions: "212", cpa_minor: "336", client_cpa_minor: "954", current_budget_minor: "15000", new_budget_minor: "18000",
    } },
    reason: "English fallback",
  };

  it("labels it as a GLIO suggestion and writes the reason from the evidence, in English", () => {
    const html = render({ rows: [suggestion] }).replace(/<[^>]+>/g, "");
    expect(html).toContain(dict.en.glioSuggestion);
    expect(html).toContain("SAR 3.36");
    expect(html).toContain("SAR 9.54");
    expect(html).toContain("from SAR 150.00 to SAR 180.00");
    expect(html).not.toContain("English fallback");
  });

  it("and in Arabic", () => {
    const html = render({ rows: [suggestion], lang: "ar", t: dict.ar }).replace(/<[^>]+>/g, "");
    expect(html).toContain(dict.ar.glioSuggestion);
    expect(html).toContain("3.36 ر.س");
    expect(html).toContain("180.00 ر.س");
  });

  it("owners and managers get the 'check now' button; others don't", () => {
    expect(render({ rows: [] })).toContain(dict.en.checkSuggestions);
    expect(render({ rows: [], canDecide: false })).not.toContain(dict.en.checkSuggestions);
  });
});

describe("approve buttons name the action", () => {
  it("pause, turn on and budget requests each get their own label", () => {
    const html = render({ rows: [
      { ...base, id: "00000000-0000-4000-8000-0000000000a1", kind: "campaign.pause", payload: {} },
      { ...base, id: "00000000-0000-4000-8000-0000000000a2", kind: "campaign.enable", payload: {} },
      { ...base, id: "00000000-0000-4000-8000-0000000000a3" },
    ] });
    expect(html).toContain(dict.en.approvePause);
    expect(html).toContain(dict.en.approveEnable);
    expect(html).toContain(dict.en.approveBudget);
  });
});

