import type { Figure } from "@glio/reports";
import type { Delta } from "@/lib/delta";

export interface KpiProps {
  label: string;
  figure: Figure | undefined;
  delta: Delta | null;
  lang: "ar" | "en";
  /** e.g. "vs previous 30 days" */
  comparedTo: string;
  missingLabel: string;
  href?: string;
}

/** A stat tile: label, exact value, and the change vs the previous period (arrow + text, never colour alone). */
export function Kpi({ label, figure, delta, lang, comparedTo, missingLabel, href }: KpiProps) {
  const value = figure?.status === "value" && figure.display ? figure.display[lang] : null;
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      {value ? <div className="kpi-value"><span className="num">{value}</span></div> : <div className="kpi-missing">{missingLabel}</div>}
      {delta && value && (
        <div className={`kpi-delta ${delta.tone}`}>
          <span aria-hidden="true">{delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "■"}</span>{" "}
          <span className="num">{delta.percent}%</span> <span className="kpi-vs">{comparedTo}</span>
        </div>
      )}
    </>
  );
  return href && value ? <a className="kpi" href={href}>{body}</a> : <div className="kpi">{body}</div>;
}
