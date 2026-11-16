import { minorToDecimalString } from "@glio/core";

/**
 * Deterministic display formatting. No Intl/ICU dependence, so a figure's
 * text is identical everywhere it is rendered (portal, PDF, email) and the
 * commentary validator can match it exactly.
 *
 *  en            1,234.56   SAR 1,234.56   12.34%
 *  ar + latn     1,234.56   1,234.56 ر.س   12.34%
 *  ar + arab     ١٬٢٣٤٫٥٦   ١٬٢٣٤٫٥٦ ر.س   ١٢٫٣٤٪
 */

export type Digits = "latn" | "arab";
export interface DisplayOptions {
  digits: Digits; // digits used in Arabic text (English always uses latn)
}

const ARABIC_INDIC = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const CURRENCY_AR: Record<string, string> = { SAR: "ر.س", AED: "د.إ", KWD: "د.ك", QAR: "ر.ق", BHD: "د.ب", OMR: "ر.ع", USD: "دولار" };

/** "1234567.5" -> "1,234,567.5" (or Arabic-Indic with ٬ and ٫). */
export function formatDecimal(decimal: string, lang: "en" | "ar", digits: Digits): string {
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction] = (negative ? decimal.slice(1) : decimal).split(".");
  const arab = lang === "ar" && digits === "arab";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, arab ? "٬" : ",");
  let text = fraction === undefined ? grouped : `${grouped}${arab ? "٫" : "."}${fraction}`;
  if (arab) text = text.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]!);
  return (negative ? "-" : "") + text;
}

export function formatMoney(minor: bigint, currency: string, lang: "en" | "ar", digits: Digits): string {
  const amount = formatDecimal(minorToDecimalString(minor, currency), lang, digits);
  return lang === "en" ? `${currency} ${amount}` : `${amount} ${CURRENCY_AR[currency] ?? currency}`;
}

export function formatPercent(decimal: string, lang: "en" | "ar", digits: Digits): string {
  const n = formatDecimal(decimal, lang, digits);
  return lang === "ar" && digits === "arab" ? `${n}٪` : `${n}%`;
}

/**
 * Exact n/d rounded half-up to `decimals` places, as a decimal string.
 * Used only for DERIVED display figures (CTR, CPC, CPA); the underlying
 * stored numbers are never rounded.
 */
export function roundRatio(n: bigint, d: bigint, decimals: number): string {
  if (d === 0n) throw new Error("division by zero");
  const negative = n < 0n !== d < 0n;
  const N = (n < 0n ? -n : n) * 10n ** BigInt(decimals);
  const D = d < 0n ? -d : d;
  let q = N / D;
  if ((N % D) * 2n >= D) q += 1n;
  const s = q.toString().padStart(decimals + 1, "0");
  const out = decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return negative && q !== 0n ? `-${out}` : out;
}

/** numeric(…,4) text like "29.0000" or "1.5000" -> "29" / "1.5" (no rounding, trailing zeros only). */
export function trimDecimal(decimal: string): string {
  if (!decimal.includes(".")) return decimal;
  return decimal.replace(/0+$/, "").replace(/\.$/, "");
}
