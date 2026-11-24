import { METRIC_LABELS, type ReportModel, SCOPE_LABELS } from "./figures.ts";

/**
 * The report email: built ONLY from a stored report snapshot (the same figures
 * and display text as the dashboard) and its validated commentary. Nothing
 * here computes or rounds a number. Every value is HTML-escaped. Arabic emails
 * are right-to-left, with numbers isolated so they keep their order.
 */

export type EmailLang = "ar" | "en";

export interface ReportEmailInput {
  report: ReportModel;
  commentary: { ar: string; en: string; source: "llm" | "template" };
  clientName: string;
  lang: EmailLang;
  /** Link to the snapshot in GLIO (for people with a GLIO account). */
  snapshotUrl?: string;
  /** Read-only share link (works without a GLIO account); preferred over snapshotUrl. */
  shareUrl?: string;
  shareDays?: number;
  /** Who to write to for questions or to stop these emails. */
  contactEmail: string;
  /** This recipient's own unsubscribe link (one click, no account). */
  unsubscribeUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const T = {
  ar: {
    title: "تقرير الأداء الإعلاني",
    period: "الفترة",
    summary: "الملخص",
    summaryLlm: "كُتب بالذكاء الاصطناعي، وكل رقم فيه مطابق للأرقام أدناه",
    summaryTemplate: "ملخص تلقائي من الأرقام",
    figures: "الأرقام",
    notProvided: "غير متوفر من المنصة",
    notApplicable: "لا ينطبق",
    recon: { ok: "مطابق للمنصة", drift: "قيد المطابقة: فرق أكبر من 0.5%", not_comparable: "تعذّرت المقارنة", unchecked: "لم تتم المطابقة بعد" },
    noData: "لا توجد بيانات إعلانية لهذه الفترة.",
    open: "عرض التقرير في GLIO",
    openShared: "عرض التقرير كاملًا",
    shareValid: (d: number) => `يعمل الرابط لمدة ${d} يومًا ولا يحتاج إلى حساب.`,
    trust: "كل رقم في هذا التقرير مصدره بيانات المنصة الإعلانية نفسها، ومطابَق مع مجاميعها.",
    why: "وصلك هذا البريد لأنك مُضاف كمستلم لتقارير هذا العميل. للاستفسار أو لإيقاف هذه الرسائل راسلنا على",
    whyShort: "وصلك هذا البريد لأنك مُضاف كمستلم لتقارير هذا العميل.",
    unsubscribe: "إيقاف هذه الرسائل",
    questions: "للاستفسار راسلنا على",
    subject: (client: string, from: string, to: string) => `تقرير أداء ${client}: ${from} إلى ${to}`,
    range: (from: string, to: string) => `من ${from} إلى ${to}`,
  },
  en: {
    title: "Ad performance report",
    period: "Period",
    summary: "Summary",
    summaryLlm: "Written by AI; every number in it matches the figures below",
    summaryTemplate: "Automatic summary from the figures",
    figures: "Figures",
    notProvided: "Not provided by platform",
    notApplicable: "Not applicable",
    recon: { ok: "Matches the platform", drift: "Being reconciled: difference above 0.5%", not_comparable: "Could not compare", unchecked: "Not reconciled yet" },
    noData: "No advertising data for this period.",
    open: "Open the report in GLIO",
    openShared: "View the full report",
    shareValid: (d: number) => `The link works for ${d} days and needs no account.`,
    trust: "Every figure in this report comes from the ad platform's own data and is checked against its totals.",
    why: "You received this because you were added as a report recipient for this client. For questions, or to stop these emails, write to",
    whyShort: "You received this because you were added as a report recipient for this client.",
    unsubscribe: "Unsubscribe from these emails",
    questions: "Questions? Write to",
    subject: (client: string, from: string, to: string) => `${client} performance report: ${from} to ${to}`,
    range: (from: string, to: string) => `${from} to ${to}`,
  },
} as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const NUMBERISH = /([0-9٠-٩۰-۹](?:[0-9٠-٩۰-۹.,٫٬:\/\-%٪]*[0-9٠-٩۰-۹%٪])?)/g;

/** Escape, then wrap numbers in left-to-right spans so Arabic layout can't reorder them. */
function isolate(text: string): string {
  return text
    .split(NUMBERISH)
    .map((part, i) => (i % 2 === 1 ? `<span dir="ltr" style="unicode-bidi:isolate">${escapeHtml(part)}</span>` : escapeHtml(part)))
    .join("");
}

/** Single line, no control characters (subjects end up in mail headers). */
function headerSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function renderReportEmail(input: ReportEmailInput): RenderedEmail {
  const { report, lang } = input;
  const t = T[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const align = lang === "ar" ? "right" : "left";
  const { from, to } = report.period;
  const subject = headerSafe(t.subject(input.clientName, from, to));
  const commentary = lang === "ar" ? input.commentary.ar : input.commentary.en;

  const scopes = [...report.channels.map((c) => c.scope), ...(report.figures.some((f) => f.scope === "total") ? ["total"] : [])];
  const reconOf = (scope: string) => report.channels.find((c) => c.scope === scope)?.reconciliation;
  const scopeLabel = (scope: string) => SCOPE_LABELS[scope]?.[lang] ?? SCOPE_LABELS[scope.split("_")[0]!]?.[lang] ?? scope;

  const textLines: string[] = [t.title, input.clientName, `${t.period}: ${t.range(from, to)}`, "", `${t.summary}:`, commentary, ""];
  let sections = "";
  for (const scope of scopes) {
    const recon = reconOf(scope);
    const rows = report.figures
      .filter((f) => f.scope === scope)
      .map((f) => {
        const label = METRIC_LABELS[f.metric][lang];
        const value = f.status === "value" && f.display ? f.display[lang] : f.status === "not_applicable" ? t.notApplicable : t.notProvided;
        textLines.push(`${scopeLabel(scope)} - ${label}: ${value}`);
        const valueHtml = f.status === "value"
          ? `<strong dir="ltr" style="unicode-bidi:isolate">${escapeHtml(value)}</strong>`
          : `<span style="color:#56606b">${escapeHtml(value)}</span>`;
        return `<tr><td style="padding:8px 0;border-bottom:1px solid #e6e9ee;color:#56606b">${escapeHtml(label)}</td>`
          + `<td style="padding:8px 0;border-bottom:1px solid #e6e9ee;text-align:${lang === "ar" ? "left" : "right"}">${valueHtml}</td></tr>`;
      })
      .join("");
    const badge = recon ? `<span style="font-size:13px;color:${recon === "ok" ? "#0d6b58" : "#8a4b00"}">${isolate(t.recon[recon])}</span>` : "";
    if (recon) textLines.push(`${scopeLabel(scope)}: ${t.recon[recon]}`);
    textLines.push("");
    sections += `<h3 style="margin:24px 0 4px;font-size:16px">${escapeHtml(scopeLabel(scope))}</h3>${badge}`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">${rows}</table>`;
  }
  if (scopes.length === 0) {
    sections = `<p style="color:#56606b">${escapeHtml(t.noData)}</p>`;
    textLines.push(t.noData, "");
  }

  const target = input.shareUrl ?? input.snapshotUrl;
  const label = input.shareUrl ? t.openShared : t.open;
  const button = target
    ? `<p style="margin:28px 0 8px"><a href="${escapeHtml(target)}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`
      + (input.shareUrl ? `<p style="margin:0 0 20px;font-size:12px;color:#56606b">${isolate(t.shareValid(input.shareDays ?? 30))}</p>` : "")
    : "";
  if (target) textLines.push(`${label}: ${target}`, "");
  if (input.unsubscribeUrl) {
    textLines.push(t.trust, t.whyShort, `${t.unsubscribe}: ${input.unsubscribeUrl}`, `${t.questions} ${input.contactEmail}`, "GLIO · glioagency.org");
  } else {
    textLines.push(t.trust, `${t.why} ${input.contactEmail}`, "GLIO · glioagency.org");
  }
  const mail = `<a href="mailto:${escapeHtml(input.contactEmail)}" style="color:#2563eb">${escapeHtml(input.contactEmail)}</a>`;
  const footer = input.unsubscribeUrl
    ? `${escapeHtml(t.whyShort)} <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#2563eb">${escapeHtml(t.unsubscribe)}</a>.<br>${escapeHtml(t.questions)} ${mail}`
    : `${escapeHtml(t.why)} ${mail}`;

  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f3f5f8;font-family:Tahoma,Arial,'Segoe UI',sans-serif;color:#1b1f23">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden" dir="${dir}">
<tr><td style="background:#050b18;padding:20px 28px;text-align:${align}"><span style="color:#ffffff;font-weight:800;font-size:20px;letter-spacing:1px">GLIO<span style="color:#60a5fa">.</span></span></td></tr>
<tr><td style="padding:28px;text-align:${align}" dir="${dir}">
<p style="margin:0;color:#56606b;font-size:14px">${escapeHtml(t.title)}</p>
<h1 style="margin:4px 0 8px;font-size:22px">${escapeHtml(input.clientName)}</h1>
<p style="margin:0;color:#56606b">${escapeHtml(t.period)}: ${isolate(t.range(from, to))}</p>
<h2 style="margin:28px 0 4px;font-size:17px">${escapeHtml(t.summary)}</h2>
<p style="margin:0 0 6px;font-size:12px;color:#56606b">${isolate(input.commentary.source === "llm" ? t.summaryLlm : t.summaryTemplate)}</p>
<p style="margin:0;font-size:15px;line-height:1.7;white-space:pre-line">${isolate(commentary)}</p>
<h2 style="margin:28px 0 0;font-size:17px">${escapeHtml(t.figures)}</h2>
${sections}
${button}
<p style="margin:28px 0 0;font-size:12px;color:#56606b;line-height:1.6">${isolate(t.trust)}<br>${footer}</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;color:#56606b;font-size:12px;text-align:${align}">GLIO · <a href="https://www.glioagency.org" style="color:#56606b">glioagency.org</a></td></tr>
</table></td></tr></table>
</body></html>`;

  return { subject, html, text: textLines.join("\n") };
}
