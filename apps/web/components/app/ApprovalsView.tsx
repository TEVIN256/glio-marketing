import { decodeSkipped, describeChange, describeReason, describeState, isSuggestion } from "@/lib/approvals";
import { isolateNumbers } from "@/components/ReportView";
import { ERROR_HINTS } from "@/lib/errors";
import type { Dict, Lang } from "@/lib/i18n";
import { PageHeader } from "./PageHeader";
import { checkSuggestions, decideApproval, undoChange } from "@/app/(app)/w/[ws]/approvals/actions";

const UNDO_DAYS = 30;
const fmtTime = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export interface ApprovalListRow {
  id: string; client_id: string; kind: string; payload: Record<string, unknown> | null; status: string;
  requested_by: string | null; requested_by_agent: string | null; reason: string | null; target_name: string | null;
  target_id: string | null; ad_account_id: string | null; before_state: { status?: string | null; budgetMinor?: string | null } | null;
  after_state: { status?: string | null; budgetMinor?: string | null } | null; created_at: string; decided_at: string | null;
  decision_note: string | null; executed_at: string | null; error_code: string | null; expires_at: string | null; undo_of: string | null;
}

export interface ApprovalsViewProps {
  ws: string;
  workspaceName: string;
  rows: ApprovalListRow[];
  clients: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; currency: string | null }>;
  userId: string;
  canDecide: boolean;
  tab: "pending" | "history";
  q: Record<string, string | undefined>;
  lang: Lang;
  t: Dict;
  now?: number;
}

/** Pending requests to decide, and the history of applied / rejected / failed / undone changes. */
export function ApprovalsView({ ws, workspaceName, rows, clients, accounts, userId: uid, canDecide, tab, q, lang, t, now = Date.now() }: ApprovalsViewProps) {
  const tx = (key: string): string | undefined => (t as Record<string, string>)[key];
  const user = { id: uid };
  const workspace = { name: workspaceName };
  const clientName = (id: string) => clients?.find((c) => c.id === id)?.name ?? "";
  const currencyOf = (id: string | null) => accounts?.find((a) => a.id === id)?.currency ?? null;
  const pending = (rows ?? []).filter((r) => r.status === "pending" && (!r.expires_at || new Date(r.expires_at).getTime() > now));
  const history = (rows ?? []).filter((r) => !pending.includes(r));
  const who = (r: { requested_by: string | null; requested_by_agent: string | null }) =>
    isSuggestion(r) ? "GLIO" : r.requested_by_agent ?? (r.requested_by === user.id ? t.requestedByYou : t.requestedByMember);
  const statusOf = (r: { status: string; expires_at: string | null }) =>
    r.status === "pending" && r.expires_at && new Date(r.expires_at).getTime() <= now ? "expired" : r.status;
  // Undo is offered only on the latest change in effect for each campaign.
  const latestExecuted = new Map<string, string>();
  for (const r of rows) {
    if (r.status !== "executed" || !r.executed_at) continue;
    const key = `${r.ad_account_id}:${r.target_id}`;
    if (!latestExecuted.has(key) || r.executed_at > latestExecuted.get(key)!) latestExecuted.set(key, r.executed_at);
  }
  const tone: Record<string, string> = { executed: "ok", undone: "other", rejected: "other", expired: "other", failed: "drift", pending: "drift", approved: "ok", executing: "drift" };

  return (
    <div className="page">
      <PageHeader crumbs={[{ href: "/app", label: t.workspaces }, { href: `/w/${ws}`, label: workspace.name }]} title={t.approvalsTitle} subtitle={t.approvalsSub}
        actions={canDecide && (
          <form action={checkSuggestions}>
            <input type="hidden" name="ws" value={ws} />
            <button type="submit" className="secondary">✦ {t.checkSuggestions}</button>
          </form>
        )} />
      <p className="fine-print">{t.sgExplain}</p>
      {q.sg !== undefined && (
        <div className="notice" role="status">
          <p style={{ margin: 0 }}>{Number(q.sg) > 0 ? t.sgResult.replace("{n}", String(Number(q.sg))) : t.sgNone}</p>
          {decodeSkipped(q.sk).length > 0 && (
            <>
              <p style={{ margin: "8px 0 4px" }}><strong>{t.sgSkippedTitle}</strong></p>
              <ul className="skip-list">
                {decodeSkipped(q.sk).map((k, i) => <li key={i}><strong>{k.name}</strong>: {tx(`skip_${k.reason}`) ?? k.reason}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {q.ap && tx(`apResult_${q.ap}`) && <p className="notice" role="status">{tx(`apResult_${q.ap}`)}</p>}
      {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
      {q.e === "approval" && (
        <p className="notice error" role="alert">
          {t.apError} {q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null} {q.code && <code className="num">({q.code})</code>}
        </p>
      )}

      <nav className="tabs" aria-label={t.approvalsTitle}>
        <a href={`/w/${ws}/approvals`} className={tab === "pending" ? "tab active" : "tab"} aria-current={tab === "pending" ? "true" : undefined}>
          {t.tabPending} <span className="count">{pending.length}</span>
        </a>
        <a href={`/w/${ws}/approvals?tab=history`} className={tab === "history" ? "tab active" : "tab"} aria-current={tab === "history" ? "true" : undefined}>
          {t.tabHistory}
        </a>
      </nav>

      {tab === "pending" && (
        pending.length === 0 ? (
          <section className="empty-state"><h2>{t.noPending}</h2></section>
        ) : (
          <div className="approval-list">
            {pending.map((r) => (
              <article key={r.id} className={isSuggestion(r) ? "card approval-card suggested" : "card approval-card"}>
                <div className="approval-main">
                  <div className="approval-meta">
                    <span className="badge drift">{t.apStatus_pending}</span>
                    {isSuggestion(r) && <span className="badge suggestion">✦ {t.glioSuggestion}</span>}
                    <span className="muted">{clientName(r.client_id)}</span>
                  </div>
                  <h2 className="approval-title">{describeChange(r, currencyOf(r.ad_account_id), lang, t)}</h2>
                  {describeReason(r, lang, t) && (
                    <p className="approval-reason"><span className="muted">{t.reasonLabel}:</span> {isolateNumbers(describeReason(r, lang, t)!)}</p>
                  )}
                  <p className="muted approval-small">
                    {t.requestedBy} {who(r)} · <span className="num">{fmtTime(r.created_at)}</span>
                    {r.expires_at && <> · {t.expiresAt} <span className="num">{fmtTime(r.expires_at)}</span></>}
                  </p>
                </div>
                {canDecide ? (
                  <form className="approval-actions" action={decideApproval}>
                    <input type="hidden" name="ws" value={ws} />
                    <input type="hidden" name="id" value={r.id} />
                    <label className="sr-only" htmlFor={`note-${r.id}`}>{t.noteLabel}</label>
                    <input id={`note-${r.id}`} name="note" placeholder={t.noteLabel} maxLength={500} />
                    <div className="approval-buttons">
                      <button type="submit" name="decision" value="approve">
                        {r.kind === "campaign.pause" ? t.approvePause : r.kind === "campaign.enable" ? t.approveEnable : r.kind === "campaign.budget" ? t.approveBudget : t.approveRun}
                      </button>
                      <button type="submit" name="decision" value="reject" className="secondary">{t.reject}</button>
                    </div>
                  </form>
                ) : (
                  <p className="notice">{t.waitingForApprover}</p>
                )}
              </article>
            ))}
          </div>
        )
      )}

      {tab === "history" && (
        history.length === 0 ? (
          <section className="empty-state"><h2>{t.noHistory}</h2></section>
        ) : (
          <section className="card">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t.changeCol}</th>
                    <th scope="col">{t.beforeAfter}</th>
                    <th scope="col">{t.requestedBy}</th>
                    <th scope="col">{t.statusCol}</th>
                    <th scope="col"><span className="sr-only">{t.actions}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => {
                    const st = statusOf(r);
                    const cur = currencyOf(r.ad_account_id);
                    const undoable = canDecide && st === "executed" && !r.undo_of && r.executed_at
                      && latestExecuted.get(`${r.ad_account_id}:${r.target_id}`) === r.executed_at
                      && now - new Date(r.executed_at).getTime() < UNDO_DAYS * 86_400_000;
                    return (
                      <tr key={r.id}>
                        <th scope="row">
                          <span className="campaign-name">{describeChange(r, cur, lang, t)}</span>
                          <span className="campaign-id">{[clientName(r.client_id), r.undo_of ? t.undoOfEarlier : describeReason(r, lang, t)].filter(Boolean).join(" · ")}</span>
                        </th>
                        <td>
                          {r.before_state || r.after_state ? (
                            <span className="before-after">
                              <span>{describeState(r.before_state, cur, lang, t)}</span>
                              <span aria-hidden="true" className="flip muted">→</span>
                              <strong>{describeState(r.after_state, cur, lang, t)}</strong>
                            </span>
                          ) : <span className="muted">—</span>}
                        </td>
                        <td className="muted">{who(r)}<br /><span className="num">{fmtTime(r.executed_at ?? r.decided_at ?? r.created_at)}</span></td>
                        <td>
                          <span className={`badge ${tone[st] ?? "other"}`}>{tx(`apStatus_${st}`) ?? st}</span>
                          {st === "failed" && r.error_code && (
                            <div className="approval-small muted">{ERROR_HINTS[r.error_code]?.[lang] ?? <code>{r.error_code}</code>}</div>
                          )}
                        </td>
                        <td className="n">
                          {undoable && (
                            <form action={undoChange}>
                              <input type="hidden" name="ws" value={ws} />
                              <input type="hidden" name="id" value={r.id} />
                              <button type="submit" className="secondary">{t.undo}</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )
      )}
    </div>
  );
}
