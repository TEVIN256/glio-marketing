import { describe, expect, it } from "vitest";
import { summarizeViews } from "@/lib/report-views";

const row = (at: string, over: Partial<Parameters<typeof summarizeViews>[0][number]> = {}) => ({
  created_at: at, actor_kind: "user", actor_user_id: "u1", action: "report.viewed", metadata: null, ...over,
});

describe("who viewed this report", () => {
  it("groups members by person and outside viewers by share link, with counts and first/last view, latest first", () => {
    const v = summarizeViews([
      row("2026-11-27T10:00:00Z"),
      row("2026-11-25T08:00:00Z"),
      row("2026-11-26T09:00:00Z", { actor_user_id: "u2" }),
      row("2026-11-27T11:00:00Z", { actor_kind: "system", actor_user_id: null, action: "report.share_viewed", metadata: { share_id: "s1" } }),
      row("2026-11-24T11:00:00Z", { actor_kind: "system", actor_user_id: null, action: "report.share_viewed", metadata: { share_id: "s1" } }),
    ]);
    expect(v).toEqual([
      { kind: "share", id: "s1", views: 2, first: "2026-11-24T11:00:00Z", last: "2026-11-27T11:00:00Z" },
      { kind: "member", id: "u1", views: 2, first: "2026-11-25T08:00:00Z", last: "2026-11-27T10:00:00Z" },
      { kind: "member", id: "u2", views: 1, first: "2026-11-26T09:00:00Z", last: "2026-11-26T09:00:00Z" },
    ]);
  });

  it("ignores other actions and entries without a person", () => {
    expect(summarizeViews([
      row("2026-11-27T10:00:00Z", { action: "figure.viewed" }),
      row("2026-11-27T10:00:00Z", { actor_kind: "system", actor_user_id: null }),
    ])).toEqual([]);
  });
});
