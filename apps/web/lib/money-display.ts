import { minorToDecimalString } from "@glio/core";
import { formatMoney as fmt } from "@glio/reports";

/** Display helpers for amounts stored as minor-unit strings. */
export function formatMoney(minor: string, currency: string, lang: "ar" | "en"): string {
  return fmt(BigInt(minor), currency, lang, "latn");
}

/** "15000" SAR -> "150.00" for an input field. */
export function minorToDecimalForInput(minor: string, currency: string): string {
  return minorToDecimalString(BigInt(minor), currency);
}
