/** "Nov 9" / "9 نوفمبر" from YYYY-MM-DD. Plain module: usable on the server and in client components. */
const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
};

export function shortDate(iso: string, lang: "ar" | "en"): string {
  const m = MONTHS[lang][Number(iso.slice(5, 7)) - 1];
  const d = Number(iso.slice(8, 10));
  return lang === "en" ? `${m} ${d}` : `${d} ${m}`;
}
