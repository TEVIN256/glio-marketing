/**
 * Turn a server-side failure into a short, safe code for logs and the UI.
 * Postgres errors carry a SQLSTATE code (e.g. 28P01 = wrong password);
 * network/TLS errors carry a Node code (e.g. ENOTFOUND). Neither includes
 * credentials. The raw message is logged (it never contains the password),
 * the UI shows only the code and a hint.
 */
export function describeError(err: unknown): { code: string; message: string } {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" && /^[A-Z0-9_]{2,40}$/i.test(e.code) ? e.code : "UNKNOWN";
  const message = typeof e?.message === "string" ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, "[connection string]").slice(0, 300) : String(err);
  return { code, message };
}

/** Plain-language hints for the codes we expect while setting up. */
export const ERROR_HINTS: Record<string, { ar: string; en: string }> = {
  "28P01": { ar: "كلمة مرور قاعدة البيانات في DATABASE_URL غير صحيحة.", en: "The database password in DATABASE_URL is wrong." },
  "28000": { ar: "اسم المستخدم في DATABASE_URL غير صحيح.", en: "The database user in DATABASE_URL is wrong." },
  ENOTFOUND: { ar: "عنوان قاعدة البيانات في DATABASE_URL غير صحيح.", en: "The database host in DATABASE_URL is wrong." },
  ECONNREFUSED: { ar: "تعذّر الاتصال بقاعدة البيانات (المنفذ أو العنوان).", en: "Could not connect to the database (host or port)." },
  ETIMEDOUT: { ar: "انتهت مهلة الاتصال بقاعدة البيانات.", en: "The database connection timed out." },
  SELF_SIGNED_CERT_IN_CHAIN: { ar: "مشكلة في شهادة الاتصال الآمن بقاعدة البيانات.", en: "TLS certificate problem connecting to the database." },
  ERR_INVALID_URL: { ar: "صيغة DATABASE_URL غير صحيحة.", en: "DATABASE_URL is not a valid connection string." },
  "42P01": { ar: "جدول ناقص: هل طُبّقت جميع ملفات الترحيل؟", en: "A table is missing: have all migrations been applied?" },
  "42501": { ar: "صلاحيات قاعدة البيانات غير كافية.", en: "Insufficient database privileges." },
};
