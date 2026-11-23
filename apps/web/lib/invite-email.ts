import { type RenderedNotification, escapeHtml } from "@glio/reports";
import { dict } from "./i18n";

/** The invitation email: Arabic first, then English. Names kept as one unit, everything escaped. */
export function renderInviteEmail(args: {
  workspaceName: string; role: "manager" | "analyst" | "client_viewer"; clientName: string | null;
  inviterEmail: string; link: string; contactEmail: string;
}): RenderedNotification {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
  const ws = clean(args.workspaceName);
  const client = args.clientName ? clean(args.clientName) : null;
  const subject = `GLIO: دعوة للانضمام إلى ${ws} · Invitation to join ${ws}`.slice(0, 200);
  const bdi = (s: string) => `<bdi>${escapeHtml(s)}</bdi>`;

  const section = (lang: "ar" | "en") => {
    const t = dict[lang];
    const role = { manager: t.roleManager, analyst: t.roleAnalyst, client_viewer: t.roleClientViewer }[args.role];
    const fill = (s: string, html: boolean) => s
      .split(/(\{ws\}|\{role\}|\{client\}|\{inviter\})/)
      .map((part) => {
        const v = { "{ws}": ws, "{role}": role, "{client}": client ?? "", "{inviter}": clean(args.inviterEmail) }[part];
        return v === undefined ? (html ? escapeHtml(part) : part) : html ? bdi(v) : v;
      }).join("");
    const line = client ? t.inviteBodyClient : t.inviteBody;
    const dir = lang === "ar" ? "rtl" : "ltr";
    return {
      html: `<div dir="${dir}" style="text-align:${lang === "ar" ? "right" : "left"}">
<h2 style="margin:0 0 8px;font-size:18px">${escapeHtml(t.inviteTitle)}</h2>
<p style="margin:0 0 6px">${fill(line, true)}</p>
<p style="margin:0 0 16px;color:#56606b;font-size:14px">${escapeHtml(t.inviteHowTo)}</p>
<p style="margin:0 0 6px"><a href="${escapeHtml(args.link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(t.inviteAccept)}</a></p>
<p style="margin:8px 0 0;color:#56606b;font-size:12px">${escapeHtml(t.inviteExpiry)}</p></div>`,
      text: [t.inviteTitle, fill(line, false), t.inviteHowTo, `${t.inviteAccept}: ${args.link}`, t.inviteExpiry].join("\n"),
    };
  };
  const ar = section("ar");
  const en = section("en");
  const contact = `<a href="mailto:${escapeHtml(args.contactEmail)}" style="color:#56606b">${escapeHtml(args.contactEmail)}</a>`;
  const html = `<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f3f5f8;font-family:Tahoma,Arial,'Segoe UI',sans-serif;color:#1b1f23">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#050b18;padding:18px 28px;text-align:right"><span style="color:#fff;font-weight:800;font-size:20px;letter-spacing:1px">GLIO<span style="color:#60a5fa">.</span></span></td></tr>
<tr><td style="padding:24px 28px">${ar.html}<hr style="border:0;border-top:1px solid #e3e8f0;margin:24px 0">${en.html}</td></tr>
<tr><td style="padding:14px 28px;background:#f8fafc;color:#56606b;font-size:12px">
<div dir="rtl" style="text-align:right">${escapeHtml(dict.ar.inviteIgnore)} ${contact}</div>
<div dir="ltr" style="text-align:left;margin-top:6px">${escapeHtml(dict.en.inviteIgnore)} ${contact}</div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text: `${ar.text}\n\n---\n\n${en.text}\n\n${dict.ar.inviteIgnore} ${args.contactEmail}\n${dict.en.inviteIgnore} ${args.contactEmail}` };
}
