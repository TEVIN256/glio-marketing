import { sha256OfJson } from "@glio/core";
import { METRIC_LABELS, type ReportModel, SCOPE_LABELS } from "./figures.js";
import { allowedNumbers, validateText } from "./validate.js";

/**
 * AI commentary: a short narrative of the period in Arabic and English.
 *
 * The model receives ONLY the JSON built by `commentaryInput` (period,
 * channels, figures with their display text). No raw payloads, no
 * credentials, no client names. It must not calculate; every number it writes
 * is checked against its input. On failure: one retry with a stricter
 * instruction, then a deterministic template. Every attempt is recorded.
 */

export const PROMPT_VERSION = "commentary-v1";

export const SYSTEM_PROMPT = `You write the short narrative summary for an advertising performance report prepared by a marketing agency in Saudi Arabia for its client.

You receive a JSON object with the reporting period, the channels and a list of figures. Each figure has an id, labels, a status, and (when status is "value") its display text in English (display_en) and Arabic (display_ar).

Rules:
- Use only numbers that appear in the figures' display text, copied exactly as written (same digits, decimals and separators), or dates from the period. Write the Arabic text with display_ar and the English text with display_en.
- Never calculate, estimate, round, compare or derive any number yourself: no percentages of change, no totals, no averages that are not already a figure.
- Never write numbers as words (for example "three", "half", "ثلاثة", "نصف"). Avoid phrases like "one of" or "واحدة من".
- If a figure's status is not "value", you may say it is not available; do not guess it.
- If a channel's reconciliation is "drift", say that its numbers are being checked against the platform.
- Arabic: Modern Standard Arabic, clear and professional, written for a business owner. English: the same content, natural business English.
- 3 to 5 sentences in each language. No headings, no lists, no emojis.

Return JSON with two fields: "arabic" and "english".`;

const STRICT_ADDENDUM = (violations: string[]) => `

Your previous answer was rejected because it contained: ${violations.join("; ")}.
Rewrite it. Use ONLY numbers copied character-for-character from display_ar / display_en, or none at all. Do not write any other number, and no number words.`;

export interface CommentaryModel {
  /** e.g. "claude-opus-5-5". */
  readonly name: string;
  generate(req: { system: string; user: string }): Promise<{ ar: string; en: string }>;
}

export interface CommentaryAttempt {
  attempt: number;
  kind: "llm" | "llm_strict" | "template";
  ok: boolean;
  violations: string[];
  error: string | null;
  output: { ar: string; en: string } | null;
}

export interface CommentaryResult {
  input: Record<string, unknown>;
  inputSha256: string;
  promptVersion: string;
  systemPromptSha256: string;
  model: string | null;
  source: "llm" | "template";
  ar: string;
  en: string;
  attempts: CommentaryAttempt[];
}

/** The ONLY data the model sees. */
export function commentaryInput(report: ReportModel): Record<string, unknown> {
  return {
    period: report.period,
    channels: report.channels.map((c) => ({
      id: c.scope,
      name_en: SCOPE_LABELS[c.scope]?.en ?? c.scope,
      name_ar: SCOPE_LABELS[c.scope]?.ar ?? c.scope,
      reconciliation: c.reconciliation,
    })),
    figures: report.figures.map((f) => ({
      id: f.id,
      channel: f.scope,
      metric: f.metric,
      label_en: METRIC_LABELS[f.metric].en,
      label_ar: METRIC_LABELS[f.metric].ar,
      status: f.status,
      ...(f.display ? { display_en: f.display.en, display_ar: f.display.ar } : { reason: f.reason }),
    })),
  };
}

/** Numbers the commentary may contain: every figure display (both languages) and the period's dates. */
export function allowedFor(report: ReportModel): Set<string> {
  const displays = report.figures.flatMap((f) => (f.display ? [f.display.en, f.display.ar] : []));
  return allowedNumbers(displays, report.period);
}

export async function generateCommentary(model: CommentaryModel | null, report: ReportModel): Promise<CommentaryResult> {
  const input = commentaryInput(report);
  const allowed = allowedFor(report);
  const user = JSON.stringify(input);
  const attempts: CommentaryAttempt[] = [];
  let final: { ar: string; en: string; source: "llm" | "template" } | null = null;

  if (model) {
    let violations: string[] = [];
    for (const kind of ["llm", "llm_strict"] as const) {
      const system = kind === "llm" ? SYSTEM_PROMPT : SYSTEM_PROMPT + STRICT_ADDENDUM(violations);
      try {
        const output = await model.generate({ system, user });
        const ar = validateText(output.ar, allowed);
        const en = validateText(output.en, allowed);
        violations = [...ar.violations.map((v) => `ar: ${v}`), ...en.violations.map((v) => `en: ${v}`)];
        const empty = !output.ar.trim() || !output.en.trim();
        if (empty) violations.push("empty text");
        attempts.push({ attempt: attempts.length + 1, kind, ok: violations.length === 0, violations, error: null, output });
        if (violations.length === 0) {
          final = { ar: output.ar.trim(), en: output.en.trim(), source: "llm" };
          break;
        }
      } catch (err) {
        violations = [];
        attempts.push({
          attempt: attempts.length + 1, kind, ok: false, violations: [],
          error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err), output: null,
        });
      }
    }
  }

  if (!final) {
    const t = templateCommentary(report);
    const check = [...validateText(t.ar, allowed).violations, ...validateText(t.en, allowed).violations];
    attempts.push({ attempt: attempts.length + 1, kind: "template", ok: check.length === 0, violations: check, error: null, output: t });
    if (check.length > 0) throw new Error(`Template commentary failed validation: ${check.join("; ")}`);
    final = { ...t, source: "template" };
  }

  // Missing metrics are always stated, deterministically (never left to the model).
  const missing = notProvidedSentence(report);
  return {
    input,
    inputSha256: sha256OfJson(input),
    promptVersion: PROMPT_VERSION,
    systemPromptSha256: sha256OfJson(SYSTEM_PROMPT),
    model: model?.name ?? null,
    source: final.source,
    ar: missing ? `${final.ar}\n\n${missing.ar}` : final.ar,
    en: missing ? `${final.en}\n\n${missing.en}` : final.en,
    attempts,
  };
}

// Directional isolates keep numbers and Latin names in the right order inside Arabic text.
const iso = (s: string) => `⁦${s}⁩`;

/** Deterministic fallback: only figure display text and period dates, no arithmetic. */
export function templateCommentary(report: ReportModel): { ar: string; en: string } {
  const get = (scope: string, metric: string) => report.figures.find((f) => f.scope === scope && f.metric === metric);
  const scopes = report.channels.length > 1 ? [...report.channels.map((c) => c.scope), "total"] : report.channels.map((c) => c.scope);
  const ar: string[] = [`ملخص الأداء للفترة من ${iso(report.period.from)} إلى ${iso(report.period.to)}.`];
  const en: string[] = [`Performance summary for ${report.period.from} to ${report.period.to}.`];

  for (const scope of scopes) {
    const name = SCOPE_LABELS[scope] ?? { en: scope, ar: scope };
    const parts = (["spend", "impressions", "clicks", "conversions"] as const)
      .map((m) => ({ m, f: get(scope, m) }))
      .filter((x) => x.f?.display);
    if (parts.length === 0) continue;
    ar.push(`${name.ar}: ${parts.map((x) => `${METRIC_LABELS[x.m].ar} ${iso(x.f!.display!.ar)}`).join("، ")}.`);
    en.push(`${name.en}: ${parts.map((x) => `${METRIC_LABELS[x.m].en.toLowerCase()} ${x.f!.display!.en}`).join(", ")}.`);
  }
  for (const c of report.channels) {
    if (c.reconciliation === "drift") {
      const name = SCOPE_LABELS[c.scope] ?? { en: c.scope, ar: c.scope };
      ar.push(`أرقام ${name.ar} قيد المطابقة مع المنصة.`);
      en.push(`${name.en} figures are being reconciled with the platform.`);
    }
  }
  return { ar: ar.join(" "), en: en.join(" ") };
}

function notProvidedSentence(report: ReportModel): { ar: string; en: string } | null {
  const missing = report.figures.filter((f) => f.status !== "value");
  if (missing.length === 0) return null;
  const metrics = [...new Set(missing.map((f) => f.metric))];
  return {
    ar: `غير متوفر في هذا التقرير: ${metrics.map((m) => METRIC_LABELS[m].ar).join("، ")}.`,
    en: `Not available in this report: ${metrics.map((m) => METRIC_LABELS[m].en.toLowerCase()).join(", ")}.`,
  };
}
