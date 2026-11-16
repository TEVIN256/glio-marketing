import { addDays, assertIsoDate, todayIn } from "@glio/core";

/**
 * Window for a scheduled sync: re-pull the last `lookbackDays` days up to
 * yesterday in the account's timezone. Platforms keep updating recent days
 * (late conversions), so recent days are re-fetched; the upsert makes this
 * safe and only changed rows are rewritten.
 */
export function scheduledWindow(opts: { timeZone?: string; lookbackDays?: number; now?: Date } = {}): {
  dateFrom: string;
  dateTo: string;
} {
  const lookback = opts.lookbackDays ?? 30;
  if (!Number.isInteger(lookback) || lookback < 1) throw new Error("lookbackDays must be a positive integer");
  const today = todayIn(opts.timeZone ?? "Asia/Riyadh", opts.now);
  const dateTo = addDays(today, -1);
  return { dateFrom: addDays(dateTo, -(lookback - 1)), dateTo };
}

/** Window for a one-off backfill chosen by a person. */
export function backfillWindow(dateFrom: string, dateTo: string, opts: { maxDays?: number } = {}): {
  dateFrom: string;
  dateTo: string;
} {
  assertIsoDate(dateFrom);
  assertIsoDate(dateTo);
  if (dateTo < dateFrom) throw new Error("Backfill ends before it starts");
  const maxDays = opts.maxDays ?? 366;
  if (addDays(dateFrom, maxDays - 1) < dateTo) throw new Error(`Backfill longer than ${maxDays} days; split it`);
  return { dateFrom, dateTo };
}
