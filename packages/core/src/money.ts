/**
 * Money is stored as an integer number of minor units (halalas for SAR).
 *
 * Converting a platform's decimal string to minor units is exact: no floating
 * point, and NO rounding. If a platform reports more decimals than the
 * currency has (e.g. "12.345" SAR), that is an error to investigate, not a
 * number to tidy up. Glio never adjusts a figure.
 */

/** ISO 4217 minor-unit digits for currencies we expect to see. */
const MINOR_UNIT_DIGITS: Readonly<Record<string, number>> = {
  SAR: 2, AED: 2, QAR: 2, EGP: 2, USD: 2, EUR: 2, GBP: 2, TRY: 2, INR: 2, PKR: 2,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3,
  JPY: 0, KRW: 0,
};

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function minorUnitDigits(currency: string): number {
  const digits = MINOR_UNIT_DIGITS[currency.toUpperCase()];
  if (digits === undefined) {
    throw new MoneyError(`Unknown currency "${currency}": add its ISO 4217 minor units before using it`);
  }
  return digits;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * "12.34" SAR -> 1234n. Accepts a non-negative decimal string (or a plain
 * integer/decimal number without exponent). Throws on anything else.
 */
export function decimalToMinor(value: string | number, currency: string): bigint {
  const text = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new MoneyError(`Not a non-negative decimal amount: "${String(value)}"`);

  const digits = minorUnitDigits(currency);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";

  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) {
    throw new MoneyError(
      `Amount "${text}" has more precision than ${currency} allows (${digits} decimals); refusing to round`,
    );
  }
  const paddedFraction = fraction.slice(0, digits).padEnd(digits, "0");
  return BigInt(whole + paddedFraction);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new MoneyError(`Not a non-negative finite amount: ${n}`);
  const s = String(n);
  if (/e/i.test(s)) throw new MoneyError(`Amount ${s} uses exponent notation; pass it as a string`);
  return s;
}

/**
 * Display helper: minor units -> decimal string, e.g. 1234n SAR -> "12.34".
 * Formatting for people (Arabic digits, currency symbol) happens in the UI.
 */
export function minorToDecimalString(minor: bigint, currency: string): string {
  const digits = minorUnitDigits(currency);
  const negative = minor < 0n;
  const abs = (negative ? -minor : minor).toString().padStart(digits + 1, "0");
  const whole = abs.slice(0, abs.length - digits);
  const fraction = digits > 0 ? `.${abs.slice(abs.length - digits)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
