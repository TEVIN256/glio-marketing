import { todayIn } from "@glio/core";
import type { AdPlatform, ConnectResult, SqlExecutor } from "@glio/sync";
import { presetPeriod } from "./delta";
import { describeError } from "./errors";
import { syncClientAds } from "./tiktok-sync";

/**
 * SERVER ONLY. After accounts are attached: sync the platform's last 30 complete days right away
 * (ADR-030), so the client page opens with figures. Returns the client page's query string
 * describing the outcome. A failed first sync keeps the accounts connected.
 */
export async function finishAdConnection(
  db: SqlExecutor, ws: string, client: string, result: ConnectResult, platform: AdPlatform,
): Promise<string> {
  console.info(JSON.stringify({ event: `${platform}_connected`, client, connected: result.connected.length, conflicts: result.conflicts.length }));
  let firstSync = "none";
  if (result.connected.length > 0) {
    const period = presetPeriod("30d", todayIn("Asia/Riyadh"));
    try {
      await syncClientAds(db, ws, client, period.from, period.to, "backfill", platform);
      firstSync = "ok";
    } catch (err) {
      const s = describeError(err);
      console.error(JSON.stringify({ event: `${platform}_first_sync_failed`, client, code: s.code, error: s.message }));
      firstSync = s.code;
    }
  }
  return `tt=connected&pl=${platform}&n=${result.connected.length}&c=${result.conflicts.length}&s=${encodeURIComponent(firstSync)}`;
}
