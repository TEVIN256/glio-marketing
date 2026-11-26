/**
 * Break-even ROAS (ADR-035). With a gross margin of m% (the share of each sale left
 * after product cost), ads break even when purchase value × m% = ad spend, i.e. at
 * ROAS = 100 / m. Everything is exact integer arithmetic; only display is rounded.
 * Plain module: usable on the server and in tests.
 */

/** "40" / "37.5" / "40.00" → basis points (4000 / 3750), or null if not a valid margin (0 < m ≤ 100, ≤ 2 decimals). */
export function marginToBasisPoints(input: string | number | null | undefined): number | null {
  const text = String(input ?? "").trim().replace(/%$/, "").replace(/٫/g, ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const [w = "0", f = ""] = text.split(".");
  const bp = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return bp > 0 && bp <= 10_000 ? bp : null;
}

/** Break-even ROAS as text with 2 decimals (half-up): 4000 bp → "2.50". */
export function breakEvenRoas(marginBp: number): string {
  const n = 10_000n * 100n;
  const d = BigInt(marginBp);
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return `${q / 100n}.${String(q % 100n).padStart(2, "0")}`;
}

export type Standing = "above" | "at" | "below";

/** Compare ROAS (value/spend, minor units) with break-even, exactly: value × m vs spend × 100%. */
export function standing(valueMinor: bigint, spendMinor: bigint, marginBp: number): Standing | null {
  if (spendMinor <= 0n) return null;
  const lhs = valueMinor * BigInt(marginBp);
  const rhs = spendMinor * 10_000n;
  return lhs > rhs ? "above" : lhs === rhs ? "at" : "below";
}

/** Estimated gross profit after ad spend, in minor units: value × m − spend (can be negative). Rounded half away from zero. */
export function profitAfterAds(valueMinor: bigint, spendMinor: bigint, marginBp: number): bigint {
  const scaled = valueMinor * BigInt(marginBp); // × 10^4
  const gross = (scaled + 5_000n) / 10_000n;
  return gross - spendMinor;
}
