import { type PendingItem, type RenderedNotification, escapeHtml } from "@glio/reports";
import { describeChange, describeReason, isSuggestion } from "./approvals";
import { dict } from "./i18n";

const NUMBERISH = /([0-9٠-٩۰-۹](?:[0-9٠-٩۰-۹.,٫٬:\/\-%٪]*[0-9٠-٩۰-۹%٪])?)/g;
/** Escape, then keep numbers and dates left-to-right inside Arabic text (no 16-11-2026 reversal). */
/** A name (workspace, client) kept as one unit in its own direction, e.g. "glio agency 2" inside Arabic. */
const name = (text: string) => `<bdi>${escapeHtml(text)}</bdi>`;

function isolate(text: string): string {
  return text.split(NUMBERISH)
    .map((part, i) => (i % 2 === 1 ? `<span dir="ltr" style="unicode-bidi:isolate">${escapeHtml(part)}</span>` : escapeHtml(part)))
    .join("");
}

/**
 * "Changes waiting for your approval" email: Arabic first, then English, built
 * from the same plain-language descriptions as the Approvals page. Numbers
 * come only from the stored requests (and their evidence). Everything escaped.
 */
export function renderApprovalEmail(args: { workspaceId: string; workspaceName: string; items: PendingItem[]; appUrl: string; contactEmail: string }): RenderedNotification {
  const n = args.items.length;
  const link = `${args.appUrl.replace(/\/$/, "")}/w/${args.workspaceId}/approvals`;
  const ws = args.workspaceName.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
  const subject = `GLIO: ${n} ${n === 1 ? "تغيير بانتظار موافقتك" : "تغييرات بانتظار موافقتك"} · ${n} waiting for your approval · ${ws}`.slice(0, 200);

  const section = (lang: "ar" | "en") => {
    const t = dict[lang];
    const dir = lang === "ar" ? "rtl" : "ltr";
    const align = lang === "ar" ? "right" : "left";
    const items = args.items.map((i) => {
      const title = describeChange(i, i.currency, lang, t);
      const reason = describeReason(i, lang, t);
      const who = isSuggestion(i) ? `✦ ${t.glioSuggestion}` : t.requestedByMember;
      return { title, reason, who, client: i.client_name };
    });
    const html = `
<div dir="${dir}" style="text-align:${align}">
<h2 style="margin:0 0 6px;font-size:18px">${escapeHtml(t.emailApprovalsTitle)}</h2>
<p style="margin:0 0 14px;color:#56606b">${t.emailApprovalsIntro.replace("{n}", String(n)).split("{ws}").map(isolate).join(name(ws))}</p>
${items.map((i) => `<div style="border:1px solid #e3e8f0;border-${lang === "ar" ? "right" : "left"}:4px solid #7c3aed;border-radius:10px;padding:12px 14px;margin:0 0 10px">
<div style="font-size:12px;color:#56606b">${name(i.client)} · ${escapeHtml(i.who)}</div>
<div style="font-weight:700;margin:4px 0">${isolate(i.title)}</div>
${i.reason ? `<div style="font-size:14px;color:#334155">${isolate(i.reason)}</div>` : ""}
</div>`).join("")}
<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(t.emailApprovalsButton)}</a></p>
</div>`;
    const text = [t.emailApprovalsTitle, t.emailApprovalsIntro.replace("{n}", String(n)).replace("{ws}", ws), "",
      ...items.flatMap((i) => [`- ${i.client}: ${i.title}`, ...(i.reason ? [`  ${i.reason}`] : [])]), "", `${t.emailApprovalsButton}: ${link}`].join("\n");
    return { html, text };
  };
  const ar = section("ar");
  const en = section("en");
  const contact = `<a href="mailto:${escapeHtml(args.contactEmail)}" style="color:#56606b">${escapeHtml(args.contactEmail)}</a>`;
  const footerHtml = `<div dir="rtl" style="text-align:right">${escapeHtml(dict.ar.emailApprovalsFooter)} ${contact}</div>`
    + `<div dir="ltr" style="text-align:left;margin-top:6px">${escapeHtml(dict.en.emailApprovalsFooter)} ${contact}</div>`;

  const html = `<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f3f5f8;font-family:Tahoma,Arial,'Segoe UI',sans-serif;color:#1b1f23">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#050b18;padding:18px 28px;text-align:right"><span style="color:#fff;font-weight:800;font-size:20px;letter-spacing:1px">GLIO<span style="color:#60a5fa">.</span></span></td></tr>
<tr><td style="padding:24px 28px">${ar.html}<hr style="border:0;border-top:1px solid #e3e8f0;margin:24px 0">${en.html}</td></tr>
<tr><td style="padding:14px 28px;background:#f8fafc;color:#56606b;font-size:12px">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
  return {
    subject, html,
    text: `${ar.text}\n\n---\n\n${en.text}\n\n${dict.ar.emailApprovalsFooter} ${args.contactEmail}\n${dict.en.emailApprovalsFooter} ${args.contactEmail}`,
  };
}
