import { decimalToMinor, minorToDecimalString } from "@glio/core";
import { DEMO_EXTERNAL_ID } from "./demo.ts";
import { type FetchLike, PlatformError } from "./types.ts";
import {
  TIKTOK_API_BASE, TIKTOK_CAMPAIGN_FIELDS, TIKTOK_CAMPAIGN_GET_PATH, TIKTOK_CAMPAIGN_STATUS_PATH, TIKTOK_CAMPAIGN_UPDATE_PATH,
  type TikTokCampaignListData, type TikTokEnvelope,
} from "./tiktok/api.ts";

/**
 * Campaign writes. Used ONLY by the approval executor (packages/sync
 * approvals.ts), never directly by pages or agents: every write is preceded by
 * an approved request, a guardrail check and a saved before-state.
 */

export type CampaignStatus = "ENABLE" | "DISABLE";

export interface CampaignState {
  campaignId: string;
  name: string | null;
  status: CampaignStatus | null;
  /** Daily budget in minor units of the account currency; null when the campaign has no daily budget. */
  budgetMinor: string | null;
  budgetMode: string | null;
}

export interface CampaignTarget {
  accessToken: string;
  advertiserId: string;
  campaignId: string;
  currency: string;
}

export interface CampaignWriter {
  getCampaign(t: CampaignTarget): Promise<CampaignState>;
  setStatus(t: CampaignTarget, status: CampaignStatus): Promise<void>;
  setDailyBudget(t: CampaignTarget, budgetMinor: string): Promise<void>;
}

export class TikTokCampaignWriter implements CampaignWriter {
  constructor(private readonly fetch: FetchLike = globalThis.fetch as unknown as FetchLike, private readonly apiBase = TIKTOK_API_BASE) {}

  async getCampaign(t: CampaignTarget): Promise<CampaignState> {
    const url = new URL(this.apiBase + TIKTOK_CAMPAIGN_GET_PATH);
    url.searchParams.set("advertiser_id", t.advertiserId);
    url.searchParams.set("filtering", JSON.stringify({ campaign_ids: [t.campaignId] }));
    url.searchParams.set("fields", JSON.stringify(TIKTOK_CAMPAIGN_FIELDS));
    const res = await this.fetch(url.toString(), { method: "GET", headers: { "Access-Token": t.accessToken } });
    const data = await envelope<TikTokCampaignListData>(res, TIKTOK_CAMPAIGN_GET_PATH, t.accessToken);
    const c = data.list?.find((x) => String(x.campaign_id) === t.campaignId);
    if (!c) throw new PlatformError("TikTok did not return the campaign", "tiktok", "campaign_not_found", false);
    const status = c.operation_status === "ENABLE" || c.operation_status === "DISABLE" ? c.operation_status : null;
    const daily = c.budget_mode === "BUDGET_MODE_DAY" && c.budget !== null && c.budget !== undefined && String(c.budget) !== "";
    return {
      campaignId: t.campaignId,
      name: c.campaign_name ?? null,
      status,
      budgetMinor: daily ? String(decimalToMinor(String(c.budget), t.currency)) : null,
      budgetMode: c.budget_mode ?? null,
    };
  }

  async setStatus(t: CampaignTarget, status: CampaignStatus): Promise<void> {
    await this.post(TIKTOK_CAMPAIGN_STATUS_PATH, t.accessToken, {
      advertiser_id: t.advertiserId, campaign_ids: [t.campaignId], operation_status: status,
    });
  }

  async setDailyBudget(t: CampaignTarget, budgetMinor: string): Promise<void> {
    await this.post(TIKTOK_CAMPAIGN_UPDATE_PATH, t.accessToken, {
      advertiser_id: t.advertiserId, campaign_id: t.campaignId, budget: Number(minorToDecimalString(BigInt(budgetMinor), t.currency)),
    });
  }

  private async post(path: string, accessToken: string, body: unknown): Promise<void> {
    const res = await this.fetch(this.apiBase + path, {
      method: "POST", headers: { "Access-Token": accessToken, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await envelope<unknown>(res, path, accessToken);
  }
}

async function envelope<T>(res: { status: number; json(): Promise<unknown> }, path: string, token: string): Promise<T> {
  if (res.status === 429 || res.status >= 500) throw new PlatformError(`TikTok ${path} returned HTTP ${res.status}`, "tiktok", `http_${res.status}`, true);
  if (res.status !== 200) throw new PlatformError(`TikTok ${path} returned HTTP ${res.status}`, "tiktok", `http_${res.status}`, false);
  const body = (await res.json()) as TikTokEnvelope<T>;
  if (typeof body?.code !== "number") throw new PlatformError(`TikTok ${path} returned an unexpected body`, "tiktok", "bad_shape", false);
  if (body.code !== 0) {
    const msg = String(body.message ?? "").split(token).join("[redacted]").replace(/\s+/g, " ").slice(0, 300);
    throw new PlatformError(`TikTok ${path} error ${body.code}: ${msg}`, "tiktok", `tiktok_${body.code}`, false);
  }
  return (body.data ?? {}) as T;
}

/**
 * DEMO ONLY: the synthetic account's campaigns. Nothing is sent anywhere; the
 * "current" state is the last executed change for that campaign (passed in by
 * the executor from its own records), else a fixed synthetic default.
 */
export class DemoCampaignWriter implements CampaignWriter {
  constructor(private readonly lastKnown: (campaignId: string) => Promise<CampaignState | null>) {}
  static readonly DEFAULT_BUDGET_MINOR = "15000"; // SAR 150.00, synthetic

  async getCampaign(t: CampaignTarget): Promise<CampaignState> {
    if (t.advertiserId !== DEMO_EXTERNAL_ID) throw new PlatformError("Not the demo account", "tiktok", "not_demo", false);
    return (await this.lastKnown(t.campaignId)) ?? {
      campaignId: t.campaignId, name: null, status: "ENABLE", budgetMinor: DemoCampaignWriter.DEFAULT_BUDGET_MINOR, budgetMode: "BUDGET_MODE_DAY",
    };
  }
  async setStatus(): Promise<void> {}
  async setDailyBudget(): Promise<void> {}
}
