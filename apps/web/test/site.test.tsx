import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Policy } from "@/components/Policy";
import { SiteFooter } from "@/components/SiteFooter";
import { COMPANY, fill, site } from "@/lib/site";
import { isPublicPath } from "../proxy";

/** Same keys, same number of sections/bullets/paragraphs in both languages, nothing empty. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, shape(x)]));
  return typeof v;
}
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("website text", () => {
  it("Arabic and English have the same structure and no empty text", () => {
    expect(shape(site.ar)).toEqual(shape(site.en));
    for (const s of [...strings(site.ar), ...strings(site.en)]) expect(s.trim()).not.toBe("");
  });

  it("every placeholder is filled in both languages", () => {
    for (const lang of ["ar", "en"] as const) {
      for (const s of strings(site[lang])) expect(fill(s, lang), s).not.toMatch(/\{\w+\}/);
    }
  });

  it("the privacy policy names Glio, the contact email and TikTok", () => {
    const html = renderToStaticMarkup(
      <Policy title={site.en.privacyTitle} intro={site.en.privacyIntro} sections={site.en.privacy} lang="en" updatedLabel={site.en.updated} />,
    );
    expect(html).toContain("Glio");
    expect(html).toContain(COMPANY.email);
    expect(html).toContain("TikTok");
  });

  it("the footer links the privacy policy and terms and shows the brand", () => {
    const html = renderToStaticMarkup(<SiteFooter lang="ar" s={site.ar} />);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain(COMPANY.tradeNameAr);
    if (COMPANY.crNumber) expect(html).toContain(COMPANY.crNumber);
  });
});

describe("home page content", () => {
  it("offers exactly the three agency services the owner chose, in both languages", () => {
    expect(site.en.services.map((x) => x.heading)).toEqual(["Paid ads management", "Tracking + data setup", "SEO + visibility"]);
    expect(site.ar.services).toHaveLength(3);
  });
  it("the demo request goes to the company email with a ready-made subject and body", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(site[lang].demoSubject.length).toBeGreaterThan(5);
      expect(site[lang].demoBody).toContain("\n");
    }
    expect(COMPANY.email).toBe("info@glioagency.org");
  });
});

describe("brand only, email only", () => {
  it("no public text shows the legal entity name or a phone number (owner's choice)", () => {
    expect(COMPANY.phone).toBeNull();
    for (const lang of ["ar", "en"] as const) {
      const all = strings(site[lang]).map((x) => fill(x, lang)).join("\n")
        + renderToStaticMarkup(<SiteFooter lang={lang} s={site[lang]} />);
      expect(all).not.toContain(COMPANY.legalNameEn);
      expect(all).not.toContain(COMPANY.legalNameAr);
      expect(all).not.toContain("Sutoor");
    }
  });
});

describe("public paths", () => {
  it("the website and sign-in pages are public; the app is not", () => {
    for (const p of ["/", "/privacy", "/terms", "/login", "/auth/callback"]) expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/app", "/w/123", "/diagnostics", "/privacyx", "/terms-admin"]) expect(isPublicPath(p), p).toBe(false);
  });
});
