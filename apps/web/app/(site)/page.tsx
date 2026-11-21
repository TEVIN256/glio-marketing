import { isolateNumbers } from "@/components/ReportView";
import { getLang } from "@/lib/i18n";
import { COMPANY, fill, site } from "@/lib/site";

const PLATFORMS = ["Meta Ads", "Google Ads", "TikTok", "Snapchat", "Salla", "Zid"];

/** Public home page (glioagency.org): agency services + the Glio platform. No sign-in needed. */
export default async function HomePage() {
  const lang = await getLang();
  const s = site[lang];
  const demoHref = `mailto:${COMPANY.email}?subject=${encodeURIComponent(s.demoSubject)}&body=${encodeURIComponent(s.demoBody)}`;

  return (
    <>
      <section className="hero">
        <p className="eyebrow"><span className="dot" aria-hidden="true" /> {s.eyebrow}</p>
        <h1>
          <span>{s.heroTitle1}</span>
          <span className="dim">
            {s.heroTitle2a}<span className="accent">{s.heroTitle2b}</span>
          </span>
        </h1>
        <p className="lead">{s.heroText}</p>
        <div className="cta-row">
          <a className="button primary" href="#demo">{s.heroCta}</a>
          <a className="button outline" href="#services">{s.heroSecondary}</a>
        </div>
      </section>

      <section className="platforms" aria-labelledby="platforms-h">
        <p id="platforms-h" className="kicker center">{s.platformsTitle}</p>
        <ul className="platform-list" dir="ltr">
          {PLATFORMS.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </section>

      <section id="services" className="block" aria-labelledby="services-h">
        <p className="kicker" dir="auto">{s.servicesKicker}</p>
        <h2 id="services-h">{s.servicesTitle}</h2>
        <p className="lead">{s.servicesIntro}</p>
        <div className="service-grid">
          {s.services.map((x, i) => (
            <article className="panel" key={x.heading}>
              <p className="panel-num num">0{i + 1}</p>
              <h3>{x.heading}</h3>
              {x.paragraphs.map((p) => <p key={p}>{p}</p>)}
              {x.bullets && (
                <ul className="tags" dir="ltr">
                  {x.bullets.map((b) => <li key={b}>{b}</li>)}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>

      <section id="platform" className="block" aria-labelledby="platform-h">
        <p className="kicker" dir="auto">{s.platformKicker}</p>
        <h2 id="platform-h">{s.platformTitle}</h2>
        <p className="lead">{s.platformIntro}</p>
        <div className="feature-grid">
          {s.features.map((f) => (
            <article className="panel" key={f.heading}>
              <h3>{f.heading}</h3>
              {f.paragraphs.map((p) => <p key={p}>{isolateNumbers(p)}</p>)}
            </article>
          ))}
        </div>

        <div className="two-col">
          <div>
            <h3>{s.howTitle}</h3>
            <ol className="steps">
              {s.howSteps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
          <div>
            <h3>{s.trustTitle}</h3>
            <ul className="checks">
              {s.trust.map((x) => <li key={x}>{x}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <section id="demo" className="block demo" aria-labelledby="demo-h">
        <p className="kicker" dir="auto">{s.demoKicker}</p>
        <h2 id="demo-h">{s.demoTitle}</h2>
        <p className="lead">{s.demoText}</p>
        <div className="cta-row">
          <a className="button primary" href={demoHref}>{s.demoCta}</a>
          <a className="email-link" href={`mailto:${COMPANY.email}`} dir="ltr">{COMPANY.email}</a>
        </div>
        <p className="about">{fill(s.aboutText, lang)}</p>
      </section>
    </>
  );
}
