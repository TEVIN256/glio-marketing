import { describe, expect, it } from "vitest";
import { type SyncRunRow, accountSyncs, connectionState, riyadhDateTime } from "@/lib/sync-status";
import { hintFor } from "@/lib/errors";

const run = (id: string, status: SyncRunRow["status"], at: string, code: string | null = null): SyncRunRow =>
  ({ ad_account_id: id, status, started_at: at, finished_at: status === "running" ? null : at, error_code: code });

describe("first-connection states on the client page", () => {
  const accounts = [{ id: "a1", status: "active" }, { id: "a2", status: "active" }];

  it("no account → connect; connected but never synced → sync; synced but empty → no activity; data → figures", () => {
    expect(connectionState([], new Map(), false)).toBe("no_account");
    expect(connectionState(accounts, accountSyncs(accounts, []), false)).toBe("never_synced");
    const failedOnly = accountSyncs(accounts, [run("a1", "failed", "2026-11-24T05:00:00Z", "tiktok_40105")]);
    expect(connectionState(accounts, failedOnly, false)).toBe("never_synced");
    const synced = accountSyncs(accounts, [run("a1", "succeeded", "2026-11-24T05:00:00Z")]);
    expect(connectionState(accounts, synced, false)).toBe("no_activity");
    expect(connectionState(accounts, synced, true)).toBe("has_data");
  });

  it("per account: the latest run (whatever the order) and the latest success", () => {
    const s = accountSyncs(accounts, [
      run("a1", "succeeded", "2026-11-22T05:00:00Z"),
      run("a1", "failed", "2026-11-24T05:00:00Z", "tiktok_40100"),
      run("a1", "succeeded", "2026-11-23T05:00:00Z"),
    ]);
    expect(s.get("a1")).toMatchObject({ last: { status: "failed", error_code: "tiktok_40100" }, lastSucceededAt: "2026-11-23T05:00:00Z" });
    expect(s.get("a2")).toEqual({ last: null, lastSucceededAt: null });
  });

  it("times are shown in Riyadh time (UTC+3)", () => {
    expect(riyadhDateTime("2026-11-24T21:30:00Z")).toBe("2026-11-25 00:30");
  });

  it("error hints are found for wrapped sync codes too", () => {
    expect(hintFor("SYNC_tiktok_40105", "en")).toContain("Connect TikTok");
    expect(hintFor("tiktok_40100", "ar")).toBeTruthy();
    expect(hintFor("SOMETHING_ELSE", "en")).toBeNull();
    expect(hintFor(undefined, "en")).toBeNull();
  });
});
