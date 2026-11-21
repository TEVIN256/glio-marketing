import type { Metadata } from "next";
import { Policy } from "@/components/Policy";
import { getLang } from "@/lib/i18n";
import { site } from "@/lib/site";

export const metadata: Metadata = { title: "Privacy policy | سياسة الخصوصية · Glio" };

export default async function PrivacyPage() {
  const lang = await getLang();
  const s = site[lang];
  return <Policy title={s.privacyTitle} intro={s.privacyIntro} sections={s.privacy} lang={lang} updatedLabel={s.updated} />;
}
