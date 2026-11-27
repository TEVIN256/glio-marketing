import { roundRatio } from "@glio/reports";
import type { Period } from "@/lib/delta";
import { hintFor } from "@/lib/errors";
import type { Dict } from "@/lib/i18n";
import { formatMoney } from "@/lib/money-display";
import type { StoreView } from "@/lib/store";
import { riyadhDateTime } from "@/lib/sync-status";

type Action = (formData: FormData) => Promise<void>;

/**
 * Store sales (Zid, read-only, ADR-039): what the store actually sold in the period, overall
 * ROAS (store net sales ÷ ad spend, independent of any platform's attribution) and the
 * tracking check (TikTok-reported website purchase value vs real store sales).
 */
export function StoreCard({
  view, t, lang, ws, client, period, canManage, actions,
}: {
  view: StoreView | null;
  t: Dict;
  lang: "ar" | "en";
  ws: string;
  client: string;
  period: Period;
  canManage: boolean;
  actions: { connect: Action; sync: Action; disconnect: Action };
}) {
  const hidden = (
    <>
      <input type="hidden" name="ws" value={ws} />
      <input type="hidden" name="client" value={client} />
    </>
  );
  const money = (minor: bigint) => (view?.currency ? <span className="num">{formatMoney(String(minor), view.currency, lang)}</span> : <span className="muted">—</span>);

  if (!view) {
    return (
      <section id="store" className="card stack" aria-labelledby="store-h">
        <div className="card-head"><h2 id="store-h">{t.storeTitle}</h2></div>
        <p className="muted">{t.storeIntro}</p>
        {canManage && (
          <form action={actions.connect}>
            {hidden}
            <button type="submit">{t.zidConnect}</button>
          </form>
        )}
        <p className="fine-print">{t.zidConnectHint}</p>
      </section>
    );
  }

  const c = view.connection;
  const roas = view.adSpendMinor && view.adSpendMinor > 0n && view.currency ? roundRatio(view.netMinor, view.adSpendMinor, 2) : null;
  const verdict = {
    double_counting: { text: t.trackDouble, tone: "bad" },
    pixel_missing: { text: t.trackPixel, tone: "bad" },
    consistent: { text: t.trackOk, tone: "good" },
    not_enough_data: { text: t.trackNotEnough, tone: "neutral" },
  }[view.tracking];
  const share = view.tiktokWebValueMinor !== null && view.grossMinor > 0n ? roundRatio(view.tiktokWebValueMinor * 100n, view.grossMinor, 0) : null;

  return (
    <section id="store" className="card stack" aria-labelledby="store-h">
      <div className="card-head">
        <h2 id="store-h">{t.storeTitle}</h2>
        <span className={`badge ${c.status === "active" ? "ok" : "drift"}`}>{c.status === "active" ? t.statusActive : t.storeNeedsReconnect}</span>
      </div>
      <p className="small">
        <strong><bdi>{c.name ?? c.externalStoreId}</bdi></strong>
        <span className="muted"> · <bdi dir="ltr">Zid {c.externalStoreId}</bdi>
          {c.lastSyncedAt && <> · {t.storeLastSynced} <span className="num">{riyadhDateTime(c.lastSyncedAt)}</span></>}</span>
      </p>
      {c.lastErrorCode && (
        <p className="notice error" role="alert">{t.storeError} {hintFor(c.lastErrorCode, lang)} <code className="num">({c.lastErrorCode})</code></p>
      )}

      <div className="profit-grid">
        <div className="today-tile"><div className="kpi-label">{t.storeOrders}</div>
          <div className="today-value"><span className="num">{view.orders}</span></div></div>
        <div className="today-tile"><div className="kpi-label">{t.storeNetSales}</div>
          <div className="today-value">{money(view.netMinor)}</div></div>
        <div className="today-tile"><div className="kpi-label">{t.storeOverallRoas}</div>
          <div className="today-value">{roas ? <span className="num">{roas}×</span> : <span className="muted">—</span>}</div></div>
      </div>
      <p className="small muted">
        {t.storeGross} {money(view.grossMinor)} · {t.storeRefunded} {money(view.refundedMinor)} ·{" "}
        {t.storeCancelled} <span className="num">{view.cancelledOrders}</span>
        {view.partiallyRefundedOrders > 0 && <> · {t.storePartial.replace("{n}", String(view.partiallyRefundedOrders))}</>}
      </p>
      {view.daysWithData < view.periodDays && (
        <p className="notice" role="status">
          {t.storeDaysMissing.replace("{n}", String(view.daysWithData)).replace("{m}", String(view.periodDays))}
        </p>
      )}

      <div className={`kpi-note ${verdict.tone}`} role="status">
        <strong>{t.trackTitle}:</strong> {verdict.text}
        {share !== null && <> {t.trackShare.replace("{n}", share)}</>}
      </div>
      <p className="fine-print">{t.storeFinePrint}</p>

      {canManage && (
        <div className="row-actions store-actions">
          <form action={actions.sync}>
            {hidden}
            <input type="hidden" name="from" value={period.from} />
            <input type="hidden" name="to" value={period.to} />
            <button type="submit" className="secondary">{t.storeSync}</button>
          </form>
          {c.status !== "active" && (
            <form action={actions.connect}>
              {hidden}
              <button type="submit">{t.storeReconnect}</button>
            </form>
          )}
          <details className="row-menu disconnect-menu">
            <summary className="link-button">{t.storeDisconnect}</summary>
            <form className="row-menu-panel stack" action={actions.disconnect}>
              {hidden}
              <input type="hidden" name="connection" value={c.id} />
              <p className="small">{t.storeDisconnectExplain}</p>
              <button type="submit" className="secondary danger">{t.storeDisconnectConfirm}</button>
            </form>
          </details>
        </div>
      )}
    </section>
  );
}
