/**
 * What a client's TikTok connection looks like right now, for the client page.
 * Plain module (no server imports): tested directly.
 */

export interface AccountRow { id: string; status: string }
export interface SyncRunRow {
  ad_account_id: string;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
}

export interface AccountSync {
  last: SyncRunRow | null;
  lastSucceededAt: string | null;
}

/**
 * no_account          nothing connected (except the demo account)
 * never_synced        connected, but no sync has succeeded yet
 * no_activity         synced, but this period has no figures (TikTok returned nothing)
 * has_data            figures to show
 */
export type ConnectionState = "no_account" | "never_synced" | "no_activity" | "has_data";

/** Latest run and latest success per account; runs may come in any order. */
export function accountSyncs(accounts: AccountRow[], runs: SyncRunRow[]): Map<string, AccountSync> {
  const out = new Map<string, AccountSync>();
  for (const a of accounts) {
    const mine = runs.filter((r) => r.ad_account_id === a.id).sort((x, y) => y.started_at.localeCompare(x.started_at));
    const ok = mine.find((r) => r.status === "succeeded");
    out.set(a.id, { last: mine[0] ?? null, lastSucceededAt: ok ? ok.finished_at ?? ok.started_at : null });
  }
  return out;
}

export function connectionState(accounts: AccountRow[], syncs: Map<string, AccountSync>, hasData: boolean): ConnectionState {
  if (hasData) return "has_data";
  if (accounts.length === 0) return "no_account";
  return [...syncs.values()].some((s) => s.lastSucceededAt) ? "no_activity" : "never_synced";
}

/** "2026-11-24 14:05" in Riyadh time, for "last synced" labels. */
export function riyadhDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
