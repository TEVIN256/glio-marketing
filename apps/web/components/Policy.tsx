import { POLICY_UPDATED, fill } from "@/lib/site";
import { isolateNumbers } from "./ReportView";

type Section = { heading: string; paragraphs: string[]; bullets?: string[] };

/** A privacy policy or terms page: title, intro and numbered sections. */
export function Policy({
  title, intro, sections, lang, updatedLabel,
}: { title: string; intro: string; sections: Section[]; lang: "ar" | "en"; updatedLabel: string }) {
  return (
    <article className="policy stack">
      <h1>{title}</h1>
      <p className="muted">
        {updatedLabel}: <span className="num">{POLICY_UPDATED}</span>
      </p>
      <p>{fill(intro, lang)}</p>
      {sections.map((s, i) => (
        <section key={s.heading}>
          <h2>
            <span className="num">{i + 1}.</span> {s.heading}
          </h2>
          {s.paragraphs.map((p) => (
            <p key={p}>{isolateNumbers(fill(p, lang))}</p>
          ))}
          {s.bullets && (
            <ul>
              {s.bullets.map((b) => (
                <li key={b}>{fill(b, lang)}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </article>
  );
}
