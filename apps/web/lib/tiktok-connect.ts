import { todayIn } from "@glio/core";
import type { ConnectResult, SqlExecutor } from "@glio/sync";
import { presetPeriod } from "./delta";
import { describeError } from "./errors";
import { syncClientTikTok } from "./tiktok-sync";

/**
 * SERVER ONLY. After accounts are attached: sync the last 30 complete days right away
 * (ADR-030), so the client page opens with figures. Returns the client page's query
 * string describing the outcome. A failed first sync keeps the accounts connected.
 */
export async function finishTikTokConnection(db: SqlExecutor, ws: string, client: string, result: ConnectResult): Promise<string> {
  console.info(JSON.stringify({ event: "tiktok_connected", client, connected: result.connected.length, conflicts: result.conflicts.length }));
  let firstSync = "none";
  if (result.connected.length > 0) {
    const period = presetPeriod("30d", todayIn("Asia/Riyadh"));
    try {
      await syncClientTikTok(db, ws, client, period.from, period.to, "backfill");
      firstSync = "ok";
    } catch (err) {
      const s = describeError(err);
      console.error(JSON.stringify({ event: "tiktok_first_sync_failed", client, code: s.code, error: s.message }));
      firstSync = s.code;
    }
  }
  return `tt=connected&n=${result.connected.length}&c=${result.conflicts.length}&s=${encodeURIComponent(firstSync)}`;
}
