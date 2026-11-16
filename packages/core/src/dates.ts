/**
 * Calendar dates are plain "YYYY-MM-DD" strings. All arithmetic is done in
 * UTC so no local-timezone offset can shift a date by a day.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(date: string): void {
  if (!ISO_DATE.test(date) || toUtc(date).toISOString().slice(0, 10) !== date) {
    throw new Error(`Not a valid YYYY-MM-DD date: "${date}"`);
  }
}

function toUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: string, days: number): string {
  const t = toUtc(date);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Inclusive number of days from `from` to `to`. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000) + 1;
}

/** Today's calendar date in a given IANA timezone (default Asia/Riyadh). */
export function todayIn(timeZone = "Asia/Riyadh", now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Split [from, to] into consecutive windows of at most `maxDays` days. */
export function splitWindows(from: string, to: string, maxDays: number): Array<{ from: string; to: string }> {
  assertIsoDate(from);
  assertIsoDate(to);
  if (to < from) throw new Error(`Window ends before it starts: ${from}..${to}`);
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error(`maxDays must be a positive integer`);
  const windows: Array<{ from: string; to: string }> = [];
  let start = from;
  while (start <= to) {
    const candidate = addDays(start, maxDays - 1);
    const end = candidate < to ? candidate : to;
    windows.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return windows;
}
