"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  value: number | null; // plotted value (major units for money); null = no data
  label: string | null; // exact display text for the tooltip
}

export interface TrendChartProps {
  points: TrendPoint[];
  lang: "ar" | "en";
  /** Accessible description, e.g. "Daily spend, 2026-10-19 to 2026-11-17". */
  title: string;
  noDataLabel: string;
  /** Short unit for axis ticks, e.g. "SAR" (en) / "ر.س" (ar); empty for counts. */
  unit?: string;
}

const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
};
const H = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

function niceStep(max: number, ticks: number): number {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function compact(v: number): string {
  if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${+(v / 1000).toFixed(0)}K`;
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}K`;
  return `${+v.toFixed(2)}`;
}
export function shortDate(iso: string, lang: "ar" | "en"): string {
  const m = MONTHS[lang][Number(iso.slice(5, 7)) - 1];
  const d = Number(iso.slice(8, 10));
  return lang === "en" ? `${m} ${d}` : `${d} ${m}`;
}

/**
 * Single-series daily line with a 10% area wash, a crosshair that snaps to the
 * nearest day, and a tooltip with the exact value. Days without data are gaps,
 * never zeros. Time runs left to right in both languages.
 */
export function TrendChart({ points, lang, title, noDataLabel, unit = "" }: TrendChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const values = points.map((p) => p.value).filter((v): v is number => v !== null);
    const maxV = Math.max(0, ...values);
    const step = niceStep(maxV || 1, 4);
    const top = Math.max(step, Math.ceil(maxV / step) * step);
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const plotW = width - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
    // Contiguous runs of known values: one line + area per run (gaps stay gaps).
    const runs: number[][] = [];
    points.forEach((p, i) => {
      if (p.value === null) return;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    });
    const line = runs.map((r) => r.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(points[i]!.value!).toFixed(1)}`).join(""));
    const area = runs.map((r) =>
      r.length < 2 ? "" : `${line[runs.indexOf(r)]}L${x(r[r.length - 1]!).toFixed(1)},${y(0)}L${x(r[0]!).toFixed(1)},${y(0)}Z`,
    );
    const xLabels = points.length <= 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
    return { ticks, x, y, line, area, xLabels, plotH, values };
  }, [points, width]);

  const pick = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return;
    const rel = clientX - rect.left - PAD.left;
    const plotW = width - PAD.left - PAD.right;
    const i = points.length <= 1 ? 0 : Math.round((rel / plotW) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  const h = hover === null ? null : points[hover]!;
  const tipLeft = hover === null ? 0 : geo.x(hover);

  return (
    <div className="trend" ref={wrap} dir="ltr">
      <svg
        width={width} height={H} role="img" aria-label={title} tabIndex={0}
        onPointerMove={(e) => pick(e.clientX)} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((v) => Math.min(points.length - 1, (v ?? -1) + 1));
          if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? points.length) - 1));
        }}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={geo.y(t)} y2={geo.y(t)} className="trend-grid" />
            <text x={PAD.left - 8} y={geo.y(t)} className="trend-tick" textAnchor="end" dominantBaseline="middle">
              {compact(t)}
            </text>
          </g>
        ))}
        {geo.xLabels.map((i) => (
          <text key={i} x={geo.x(i)} y={H - 8} className="trend-tick" textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
            {shortDate(points[i]!.date, lang)}
          </text>
        ))}
        {geo.area.map((d, k) => d && <path key={`a${k}`} d={d} className="trend-area" />)}
        {geo.line.map((d, k) => <path key={`l${k}`} d={d} className="trend-line" />)}
        {geo.values.length > 0 && (() => {
          const last = points.map((p, i) => [p, i] as const).filter(([p]) => p.value !== null).pop()!;
          return <circle cx={geo.x(last[1])} cy={geo.y(last[0].value!)} r={4} className="trend-dot" />;
        })()}
        {h && (
          <g>
            <line x1={tipLeft} x2={tipLeft} y1={PAD.top} y2={PAD.top + geo.plotH} className="trend-cross" />
            {h.value !== null && <circle cx={tipLeft} cy={geo.y(h.value)} r={5} className="trend-dot" />}
          </g>
        )}
      </svg>
      {unit && <div className="trend-unit">{unit}</div>}
      {h && (
        <div className="trend-tip" role="status" style={{ left: Math.min(Math.max(tipLeft, 70), width - 70) }} dir={lang === "ar" ? "rtl" : "ltr"}>
          <strong dir="ltr">{h.value === null ? noDataLabel : h.label}</strong>
          <span>{shortDate(h.date, lang)}</span>
        </div>
      )}
    </div>
  );
}
