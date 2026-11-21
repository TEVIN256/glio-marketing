import { COMPANY, fill, site } from "@/lib/site";
import { getLang } from "@/lib/i18n";
import { isolateNumbers } from "@/components/ReportView";

/** Public company home page (glioagency.org). No sign-in needed. */
export default async function HomePage() {
  const lang = await getLang();
  const s = site[lang];
  return (
    <div className="site stack">
      <section className="hero">
        <h1>{s.heroTitle}</h1>
        <p className="lead">{s.heroText}</p>
        <div className="row">
          <a className="button" href="/app">{s.heroCta}</a>
          <a className="button secondary" href="#contact">{s.heroSecondary}</a>
        </div>
      </section>

      <section aria-labelledby="features">
        <h2 id="features">{s.featuresTitle}</h2>
        <div className="feature-grid">
          {s.features.map((f) => (
            <div className="card" key={f.heading}>
              <h3>{f.heading}</h3>
              {f.paragraphs.map((p) => <p key={p}>{isolateNumbers(p)}</p>)}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="how">
        <h2 id="how">{s.howTitle}</h2>
        <ol className="steps">
          {s.howSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>

      <section aria-labelledby="trust">
        <h2 id="trust">{s.trustTitle}</h2>
        <ul className="card">
          {s.trust.map((x) => <li key={x}>{x}</li>)}
        </ul>
      </section>

      <section aria-labelledby="about">
        <h2 id="about">{s.aboutTitle}</h2>
        <p>{fill(s.aboutText, lang)}</p>
      </section>

      <section aria-labelledby="contact-h" id="contact">
        <h2 id="contact-h">{s.contactTitle}</h2>
        <dl className="kv card">
          <dt>{s.contactEmail}</dt>
          <dd><a href={`mailto:${COMPANY.email}`} dir="ltr">{COMPANY.email}</a></dd>
          {COMPANY.phone && (
            <>
              <dt>{s.contactPhone}</dt>
              <dd><a href={`tel:${COMPANY.phone.replace(/\s/g, "")}`} dir="ltr">{COMPANY.phone}</a></dd>
            </>
          )}
          {COMPANY.city && (
            <>
              <dt>{s.contactCity}</dt>
              <dd>{COMPANY.city[lang]}, {COMPANY.country[lang]}</dd>
            </>
          )}
          {COMPANY.crNumber && (
            <>
              <dt>{s.contactCr}</dt>
              <dd><span className="num">{COMPANY.crNumber}</span></dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
