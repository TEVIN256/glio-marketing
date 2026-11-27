/**
 * The Activity page's vocabulary: what each audit action means, in both
 * languages, and which group it belongs to. Unknown actions are shown as-is.
 * Plain module (no server imports).
 */

export type ActivityGroup = "views" | "changes" | "access";
export const ACTIVITY_GROUPS: ActivityGroup[] = ["views", "changes", "access"];

const A = (group: ActivityGroup | null, en: string, ar: string) => ({ group, en, ar });

export const ACTIONS: Record<string, { group: ActivityGroup | null; en: string; ar: string }> = {
  "client.viewed": A("views", "Opened the client dashboard", "فتح لوحة العميل"),
  "report.viewed": A("views", "Opened a report", "فتح تقريرًا"),
  "figure.viewed": A("views", "Opened a figure's source data", "فتح البيانات المصدرية لرقم"),
  "report.share_viewed": A("views", "A share link was opened", "فُتح رابط مشاركة"),
  "approval.requested": A("changes", "Proposed a campaign change", "اقترح تغييرًا على حملة"),
  "approval.suggested": A("changes", "GLIO suggested a change", "اقترح GLIO تغييرًا"),
  "approval.approved": A("changes", "Approved a change", "وافق على تغيير"),
  "approval.rejected": A("changes", "Rejected a change", "رفض تغييرًا"),
  "approval.executed": A("changes", "Change applied on the platform", "طُبّق التغيير على المنصة"),
  "approval.failed": A("changes", "Change failed on the platform", "فشل تطبيق التغيير على المنصة"),
  "approval.undo_requested": A("changes", "Requested an undo", "طلب التراجع عن تغيير"),
  "approval.notified": A(null, "Approval email sent", "أُرسل بريد الموافقات"),
  "guardrails.updated": A("changes", "Changed the safety limits", "عدّل حدود الأمان"),
  "suggestion_settings.updated": A("changes", "Changed suggestion settings", "عدّل إعدادات الاقتراحات"),
  "client.margin_updated": A("changes", "Changed the gross margin", "عدّل هامش الربح"),
  "client.value_sources_updated": A("changes", "Changed what counts as purchase value", "عدّل ما يُحتسب قيمةً للمشتريات"),
  "report_schedule.updated": A("changes", "Changed the report email schedule", "عدّل جدول رسائل التقارير"),
  "client.deleted": A("changes", "Deleted a client and its data", "حذف عميلًا وبياناته"),
  "ad_account.connected": A("access", "Connected an ad account", "ربط حسابًا إعلانيًا"),
  "ad_account.disconnected": A("access", "Disconnected an ad account", "فصل حسابًا إعلانيًا"),
  "store.connected": A("access", "Connected a store (Zid)", "ربط متجرًا (زد)"),
  "store.disconnected": A("access", "Disconnected a store (Zid)", "فصل متجرًا (زد)"),
  "report.shared": A("access", "Created a share link", "أنشأ رابط مشاركة"),
  "report.share_revoked": A("access", "Revoked a share link", "ألغى رابط مشاركة"),
  "member.invited": A("access", "Invited a team member", "دعا عضوًا"),
  "member.invite_revoked": A("access", "Cancelled an invitation", "ألغى دعوة"),
  "member.joined": A("access", "Joined the workspace", "انضم إلى مساحة العمل"),
  "member.role_changed": A("access", "Changed a member's role", "غيّر دور عضو"),
  "member.removed": A("access", "Removed a member", "أزال عضوًا"),
  "workspace.created": A("access", "Created the workspace", "أنشأ مساحة العمل"),
  "workspace.deleted": A("changes", "Deleted the workspace", "حذف مساحة العمل"),
  "member.account_deleted": A("access", "Deleted their GLIO account", "حذف حسابه في GLIO"),
  "report.unsubscribed": A(null, "A recipient unsubscribed from report emails", "ألغى مستلم اشتراكه في رسائل التقارير"),
  "report.resubscribed": A(null, "A recipient subscribed again", "أعاد مستلم الاشتراك"),
};

export function actionsIn(group: ActivityGroup): string[] {
  return Object.entries(ACTIONS).filter(([, v]) => v.group === group).map(([k]) => k);
}

export function describeAction(action: string, lang: "ar" | "en"): string {
  return ACTIONS[action]?.[lang] ?? action;
}
