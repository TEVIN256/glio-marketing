import type { Metadata } from "next";
import { Policy } from "@/components/Policy";
import { getLang } from "@/lib/i18n";
import { site } from "@/lib/site";

export const metadata: Metadata = { title: "Terms of service | الشروط والأحكام · Glio" };

export default async function TermsPage() {
  const lang = await getLang();
  const s = site[lang];
  return <Policy title={s.termsTitle} intro={s.termsIntro} sections={s.terms} lang={lang} updatedLabel={s.updated} />;
}
