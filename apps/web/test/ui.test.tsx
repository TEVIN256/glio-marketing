import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildReport, type ChannelTotals } from "@glio/reports";
import { ReportView, isolateNumbers } from "@/components/ReportView";
import { dict } from "@/lib/i18n";

describe("translations", () => {
  it("Arabic and English have exactly the same keys, none empty", () => {
    expect(Object.keys(dict.ar).sort()).toEqual(Object.keys(dict.en).sort());
    for (const lang of ["ar", "en"] as const) {
      for (const [k, v] of Object.entries(dict[lang])) expect(v, `${lang}.${k}`).not.toBe("");
    }
  });
});

const tiktok: ChannelTotals = {
  scope: "tiktok", currency: "SAR", rows: 6, spendMinor: 33789n, impressions: 30600n, clicks: 635n,
  conversionsScaled: 290000n, rawPayloadIds: [11, 12], reconciliation: "ok",
};
const report = buildReport({ period: { from: "2026-01-01", to: "2026-01-03" }, channels: [tiktok], total: null, digits: "latn" });
const commentary = { ar: "بلغ إنفاق تيك توك 337.89 ر.س.", en: "TikTok spend was SAR 337.89.", source: "llm" as const };

describe("ReportView", () => {
  const html = renderToStaticMarkup(
    <ReportView report={report} commentary={commentary} lang="ar" t={dict.ar} figureHref={(id) => `/f/${id}`} />,
  );

  it("renders the stored figures exactly, in Arabic", () => {
    expect(html).toContain("337.89 ر.س");
    expect(html).toContain("الإنفاق");
    expect(html).toContain("بلغ إنفاق تيك توك");
    expect(html).toContain(dict.ar.reconOk);
    expect(html).toContain(dict.ar.summaryByAi);
  });

  it("links every figure with a value to its provenance page, and shows 'not provided' for the rest", () => {
    for (const f of report.figures.filter((x) => x.status === "value")) expect(html).toContain(`href="/f/${f.id}"`);
    expect(html).not.toContain('href="/f/tiktok.roas"');
    expect(html).toContain(dict.ar.notProvided);
  });

  it("isolates numbers so they keep left-to-right order inside Arabic text", () => {
    expect(html).toMatch(/<span class="num">337\.89 ر\.س<\/span>/);
  });

  it("renders English when asked", () => {
    const en = renderToStaticMarkup(
      <ReportView report={report} commentary={commentary} lang="en" t={dict.en} figureHref={(id) => `/f/${id}`} />,
    );
    expect(en).toContain("SAR 337.89");
    expect(en).toContain("Spend");
    expect(en.replace(/<[^>]+>/g, "")).toContain("TikTok spend was SAR 337.89.");
  });
});

describe("isolateNumbers", () => {
  it("wraps dates, amounts and percentages (Western and Arabic-Indic) so they keep their order in Arabic", () => {
    const html = renderToStaticMarkup(<p>{isolateNumbers("من 2026-10-16 إلى ٢٠٢٦-١١-١٤ أنفقت 18,432.75 ر.س بنسبة 1.77%.")}</p>);
    expect(html).toContain('<span class="num">2026-10-16</span>');
    expect(html).toContain('<span class="num">٢٠٢٦-١١-١٤</span>');
    expect(html).toContain('<span class="num">18,432.75</span>');
    expect(html).toContain('<span class="num">1.77%</span>');
  });
});

import { describeError } from "@/lib/errors";
describe("describeError", () => {
  it("keeps Postgres/Node codes and strips connection strings from messages", () => {
    const pgErr = Object.assign(new Error("password authentication failed for user \"postgres.abc\""), { code: "28P01" });
    expect(describeError(pgErr)).toEqual({ code: "28P01", message: 'password authentication failed for user "postgres.abc"' });
    const urlErr = Object.assign(new Error("bad postgresql://u:secret@host:6543/db"), { code: "ERR_INVALID_URL" });
    expect(describeError(urlErr).message).not.toContain("secret");
    expect(describeError(new Error("x")).code).toBe("UNKNOWN");
  });
});
