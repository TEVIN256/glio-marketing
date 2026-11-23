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
  "3F000": { ar: "خزنة Supabase (Vault) غير مفعّلة في المشروع.", en: "Supabase Vault is not enabled in the project." },
  "42883": { ar: "خزنة Supabase (Vault) غير مفعّلة في المشروع.", en: "Supabase Vault is not enabled in the project." },
  TIKTOK_CANCELLED: { ar: "لم تتم الموافقة على الربط في تيك توك.", en: "The connection wasn't approved on TikTok." },
  TIKTOK_NOT_CONFIGURED: { ar: "بيانات تطبيق تيك توك (TIKTOK_APP_ID و TIKTOK_APP_SECRET) غير مضبوطة في Vercel.", en: "The TikTok app credentials (TIKTOK_APP_ID, TIKTOK_APP_SECRET) are not set in Vercel." },
  RESEND_NOT_CONFIGURED: { ar: "مفتاح Resend (RESEND_API_KEY) غير مضبوط في Vercel.", en: "The Resend key (RESEND_API_KEY) is not set in Vercel." },
  RESEND_401: { ar: "مفتاح Resend غير صحيح.", en: "The Resend API key is invalid." },
  RESEND_403: { ar: "مفتاح Resend لا يملك صلاحية الإرسال من هذا النطاق.", en: "The Resend key may not send from this domain." },
  RESEND_422: { ar: "رفض Resend الرسالة: تحقق من توثيق النطاق في Resend ومن عناوين المستلمين.", en: "Resend rejected the email: check the domain is verified in Resend and the recipients are valid." },
  NO_RECIPIENTS: { ar: "أضف مستلمًا واحدًا على الأقل واحفظ أولًا.", en: "Add at least one recipient and save first." },
  GUARDRAIL_MAX_INCREASE: { ar: "الزيادة أكبر من الحد المسموح في التغيير الواحد (حدود الأمان).", en: "The increase is above the per-change limit (safety limits)." },
  GUARDRAIL_MAX_DAILY_BUDGET: { ar: "الميزانية أعلى من الحد الأقصى اليومي لهذا العميل (حدود الأمان).", en: "The budget is above this client's maximum daily budget (safety limits)." },
  BUDGET_NOT_DAILY: { ar: "هذه الحملة لا تستخدم ميزانية يومية.", en: "This campaign doesn't use a daily budget." },
  ACCOUNT_NOT_ACTIVE: { ar: "الحساب الإعلاني غير نشط.", en: "The ad account isn't active." },
  UNDO_NOT_LATEST: { ar: "يوجد تغيير أحدث على هذه الحملة؛ تراجع عنه أولًا.", en: "A newer change to this campaign is in effect; undo that one first." },
  UNDO_IN_PROGRESS: { ar: "يوجد تراجع قيد التنفيذ لهذا التغيير.", en: "An undo for this change already exists." },
  "55000": { ar: "تم البتّ في هذا الطلب مسبقًا.", en: "This request was already decided." },
  TIKTOK_NO_ACCOUNTS: { ar: "لم يُختر أي حساب إعلاني في تيك توك، أو لا يوجد حساب مربوط.", en: "No TikTok ad account was authorised, or none is connected." },
};
