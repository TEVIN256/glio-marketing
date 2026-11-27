import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StoreCard } from "@/components/app/StoreCard";
import { dict } from "@/lib/i18n";
import { type StoreView, trackingVerdict } from "@/lib/store";

describe("tracking check", () => {
  const base = { storeGrossMinor: 1_000_000n, storeOrders: 40, adSpendMinor: 200_000n };
  it("flags double counting when TikTok claims more than the whole store sold", () => {
    expect(trackingVerdict({ ...base, tiktokWebValueMinor: 1_200_000n })).toBe("double_counting");
    expect(trackingVerdict({ ...base, tiktokWebValueMinor: 1_040_000n })).toBe("consistent"); // within 5% timing tolerance
  });
  it("flags a missing pixel when the store sells and ads run but TikTok records almost nothing", () => {
    expect(trackingVerdict({ ...base, tiktokWebValueMinor: 5_000n })).toBe("pixel_missing");
    expect(trackingVerdict({ ...base, storeOrders: 10, tiktokWebValueMinor: 5_000n })).toBe("consistent"); // too few orders to judge
  });
  it("says so when there isn't enough to compare", () => {
    expect(trackingVerdict({ ...base, adSpendMinor: 0n, tiktokWebValueMinor: 1n })).toBe("not_enough_data");
    expect(trackingVerdict({ ...base, tiktokWebValueMinor: null })).toBe("not_enough_data");
    expect(trackingVerdict({ ...base, storeOrders: 3, tiktokWebValueMinor: 1n })).toBe("not_enough_data");
  });
});

const noop = async () => {};
const props = { ws: "w", client: "c", period: { from: "2026-01-01", to: "2026-01-30" }, actions: { connect: noop, sync: noop, disconnect: noop } };
const view: StoreView = {
  connection: { id: "s1", name: "Test Store", externalStoreId: "42", currency: "SAR", status: "active", lastErrorCode: null, lastSyncedAt: null },
  daysWithData: 30, periodDays: 30, currency: "SAR", orders: 120, grossMinor: 3_600_000n, refundedMinor: 100_000n, netMinor: 3_500_000n,
  cancelledOrders: 4, partiallyRefundedOrders: 0, adSpendMinor: 1_000_000n, tiktokWebValueMinor: 1_800_000n, tracking: "consistent",
};

describe("StoreCard", () => {
  it("offers Connect to managers when no store is connected", () => {
    const html = renderToStaticMarkup(<StoreCard view={null} t={dict.en} lang="en" canManage {...props} />);
    expect(html).toContain(dict.en.zidConnect);
    expect(renderToStaticMarkup(<StoreCard view={null} t={dict.en} lang="en" canManage={false} {...props} />)).not.toContain("<button");
  });
  it("shows orders, net sales, overall ROAS (net ÷ spend) and the tracking verdict", () => {
    const html = renderToStaticMarkup(<StoreCard view={view} t={dict.ar} lang="ar" canManage {...props} />);
    expect(html).toContain("120");
    expect(html).toContain("35,000.00");
    expect(html).toContain("3.50×");
    expect(html).toContain(dict.ar.trackOk);
    expect(html).toContain("50%"); // TikTok credits itself with half of gross sales
  });
  it("tells viewers when the period isn't fully synced, and asks to reconnect after a refused sign-in", () => {
    const html = renderToStaticMarkup(<StoreCard view={{
      ...view, daysWithData: 12, tracking: "not_enough_data",
      connection: { ...view.connection, status: "needs_reauth", lastErrorCode: "ZID_UNAUTHORIZED" },
    }} t={dict.en} lang="en" canManage {...props} />);
    expect(html).toContain("12 of the 30 days");
    expect(html).toContain(dict.en.storeReconnect);
    expect(html).toContain("ZID_UNAUTHORIZED");
  });
});
