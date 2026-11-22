import { PRESET_KEYS, type Period, type PresetKey } from "@/lib/delta";

export interface DateRangeProps {
  basePath: string;
  period: Period;
  active: PresetKey | null;
  labels: Record<PresetKey, string> & { custom: string; from: string; to: string; apply: string };
  /** extra query params to keep (e.g. the chart metric) */
  keep?: Record<string, string>;
}

/** One row above the dashboard: presets first, then a custom range. Scopes everything below it. */
export function DateRange({ basePath, period, active, labels, keep = {} }: DateRangeProps) {
  const qs = (extra: Record<string, string>) => "?" + new URLSearchParams({ ...keep, ...extra }).toString();
  return (
    <div className="range-bar">
      <nav className="presets" aria-label={labels.custom}>
        {PRESET_KEYS.map((k) => (
          <a key={k} href={basePath + qs({ p: k })} className={active === k ? "preset active" : "preset"} aria-current={active === k ? "true" : undefined}>
            {labels[k]}
          </a>
        ))}
      </nav>
      <form className="custom-range" method="get" action={basePath}>
        {Object.entries(keep).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <label className="sr-only" htmlFor="range-from">{labels.from}</label>
        <input id="range-from" name="from" type="date" defaultValue={period.from} required dir="ltr" />
        <span aria-hidden="true" className="muted flip">→</span>
        <label className="sr-only" htmlFor="range-to">{labels.to}</label>
        <input id="range-to" name="to" type="date" defaultValue={period.to} required dir="ltr" />
        <button type="submit" className="secondary">{labels.apply}</button>
      </form>
    </div>
  );
}
