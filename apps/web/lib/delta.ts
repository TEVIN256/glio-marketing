import { addDays, daysInclusive } from "@glio/core";
import { type Figure, type MetricId, roundRatio } from "@glio/reports";

/**
 * Period-over-period change for the dashboard tiles, computed exactly from the
 * figures' stored values (bigint rationals, rounded only for display).
 */

type Rational = { n: bigint; d: bigint };

function decimalToRational(text: string): Rational {
  const [whole = "0", frac = ""] = text.split(".");
  return { n: BigInt((whole.startsWith("-") ? "-" : "") + whole.replace("-", "") + frac), d: 10n ** BigInt(frac.length) };
}

export function figureRational(f: Figure | undefined): Rational | null {
  if (!f || f.status !== "value" || !f.value) return null;
  const v = f.value;
  if (v.kind === "money") return { n: BigInt(v.minor), d: 1n };
  if (v.kind === "count") return { n: BigInt(v.value), d: 1n };
  if (v.kind === "decimal") return decimalToRational(v.value);
  return { n: BigInt(v.numerator), d: BigInt(v.denominator) };
}

export type Direction = "up" | "down" | "flat";
/** Whether "up" is good for the advertiser; spend is neither. */
export const UP_IS_GOOD: Record<MetricId, boolean | null> = {
  spend: null, impressions: true, clicks: true, conversions: true, purchase_value: true, ctr: true, cpc: false, cpa: false, roas: true,
};

export interface Delta {
  /** Absolute change in percent, one decimal, e.g. "12.4". */
  percent: string;
  direction: Direction;
  /** good / bad for the advertiser, or neutral (spend, or no change). */
  tone: "good" | "bad" | "neutral";
}

/** Change from `prev` to `cur` in percent, or null when either is missing or prev is zero. */
export function figureDelta(cur: Figure | undefined, prev: Figure | undefined): Delta | null {
  const a = figureRational(cur);
  const b = figureRational(prev);
  if (!a || !b || b.n === 0n || !cur) return null;
  // (a - b) / b = (a.n*b.d - b.n*a.d) / (b.n*a.d)
  const num = a.n * b.d - b.n * a.d;
  const den = b.n * a.d;
  const pct = roundRatio(num * 100n, den, 1);
  const abs = pct.replace("-", "");
  const direction: Direction = abs === "0.0" ? "flat" : pct.startsWith("-") ? "down" : "up";
  const good = UP_IS_GOOD[cur.metric];
  const tone = direction === "flat" || good === null ? "neutral" : (direction === "up") === good ? "good" : "bad";
  return { percent: abs, direction, tone };
}

export interface Period { from: string; to: string }

/** The period of equal length just before `p`. */
export function previousPeriod(p: Period): Period {
  const days = daysInclusive(p.from, p.to);
  return { from: addDays(p.from, -days), to: addDays(p.from, -1) };
}

export type PresetKey = "7d" | "14d" | "30d" | "90d" | "mtd" | "lastm";
export const PRESET_KEYS: PresetKey[] = ["7d", "14d", "30d", "90d", "mtd", "lastm"];

/** Date presets ending yesterday (today is incomplete), in the dashboard's timezone. */
export function presetPeriod(key: PresetKey, today: string): Period {
  const yesterday = addDays(today, -1);
  const lastN = (n: number) => ({ from: addDays(yesterday, -(n - 1)), to: yesterday });
  switch (key) {
    case "7d": return lastN(7);
    case "14d": return lastN(14);
    case "30d": return lastN(30);
    case "90d": return lastN(90);
    case "mtd": {
      const first = `${today.slice(0, 8)}01`;
      return first > yesterday ? { from: first, to: first } : { from: first, to: yesterday };
    }
    case "lastm": {
      const to = addDays(`${today.slice(0, 8)}01`, -1);
      return { from: `${to.slice(0, 8)}01`, to };
    }
  }
}

/** Which preset (if any) a period equals, for highlighting the active one. */
export function matchPreset(p: Period, today: string): PresetKey | null {
  return PRESET_KEYS.find((k) => {
    const q = presetPeriod(k, today);
    return q.from === p.from && q.to === p.to;
  }) ?? null;
}
