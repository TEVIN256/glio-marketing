/**
 * The commentary validator: every number the AI writes must appear, exactly,
 * in the figures it was given (or in the reporting period's dates).
 *
 * Text is normalised first: Arabic-Indic (٠-٩) and Persian (۰-۹) digits to
 * ASCII, the Arabic decimal separator ٫ to ".", thousands separators (, ٬)
 * removed, and invisible bidi control characters stripped. Then every digit
 * sequence is compared with the allowed set built the same way.
 *
 * Numbers written as words ("three", "ثلاثة", "half") are rejected outright:
 * they would bypass the check.
 */

const BIDI = /[‎‏؜‪-‮⁦-⁩]/g;

export function normalizeDigits(text: string): string {
  return text
    .replace(BIDI, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/(\d)[,٬](?=\d{3}(?!\d))/g, "$1");
}

/** All numbers in a text, normalised (e.g. "١٬٢٣٤٫٥ ر.س" -> ["1234.5"]). */
export function extractNumbers(text: string): string[] {
  return normalizeDigits(text).match(/\d+(?:\.\d+)?/g) ?? [];
}

const NUMBER_WORDS_EN = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
  "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million", "billion", "dozen", "half",
  "double", "twice", "triple", "quarter",
];
const NUMBER_WORDS_AR = [
  "صفر", "واحد", "واحدة", "اثنان", "اثنين", "اثنتان", "ثلاث", "ثلاثة", "أربع", "أربعة", "خمس", "خمسة", "ست", "ستة",
  "سبع", "سبعة", "ثمان", "ثماني", "ثمانية", "تسع", "تسعة", "عشر", "عشرة", "عشرون", "عشرين", "مئة", "مائة", "مئات",
  "ألف", "آلاف", "مليون", "ملايين", "مليار", "نصف", "ربع", "ضعف", "ضعفين",
];
const EN_WORDS = new RegExp(`\\b(${NUMBER_WORDS_EN.join("|")})\\b`, "gi");
// Arabic words: match as whole tokens (optionally with the article ال or a leading و/ب).
const AR_WORDS = new RegExp(`(?:^|[\\s،.؛:()\\-])(?:[وب]?(?:ال)?)(${NUMBER_WORDS_AR.join("|")})(?=$|[\\s،.؛:()\\-])`, "g");

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

export function allowedNumbers(displays: string[], period: { from: string; to: string }): Set<string> {
  const allowed = new Set<string>();
  for (const d of displays) for (const n of extractNumbers(d)) allowed.add(n);
  for (const date of [period.from, period.to]) {
    for (const part of date.split("-")) {
      allowed.add(part);
      allowed.add(String(Number(part))); // "01" and "1"
    }
  }
  return allowed;
}

export function validateText(text: string, allowed: Set<string>): ValidationResult {
  const violations: string[] = [];
  for (const n of extractNumbers(text)) {
    if (!allowed.has(n)) violations.push(`number not in input: ${n}`);
  }
  for (const m of text.matchAll(EN_WORDS)) violations.push(`number written as a word: ${m[1]}`);
  for (const m of text.matchAll(AR_WORDS)) violations.push(`number written as a word: ${m[1]}`);
  return { ok: violations.length === 0, violations };
}
