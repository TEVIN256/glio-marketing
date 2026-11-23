import {
  type CampaignState, type CampaignTarget, type CampaignWriter, DEMO_EXTERNAL_ID, DemoCampaignWriter, TikTokCampaignWriter,
} from "@glio/connectors";
import type { SecretStore } from "./secrets.ts";
import type { SqlExecutor } from "./sql.ts";

/**
 * THE executor: the only code path that changes a campaign on an ad platform.
 *
 *  1. Claims an APPROVED request (approved -> executing, under a row lock), so
 *     it can never run twice or run unapproved.
 *  2. Reads the campaign's current state from the platform (the before-state).
 *  3. Enforces the client's guardrails (max daily budget, max increase per change).
 *  4. Makes the change, reads the after-state, and stores both on the request.
 *  5. Audits success or failure. Tokens are never stored or logged.
 *
 * Undo = a new request that restores the stored before-state, decided by the
 * person who pressed Undo, executed the same way (the increase cap doesn't
 * apply to restoring a previous budget; the max daily budget still does).
 */

export interface ExecutorDeps {
  db: SqlExecutor;
  secrets: SecretStore;
  /** Override for tests; by default TikTok for real accounts, a no-op writer for the demo account. */
  writerFor?: (account: { platform: string; external_id: string }) => CampaignWriter;
}

export interface ExecuteResult {
  status: "executed" | "failed";
  errorCode?: string;
  before?: CampaignState;
  after?: CampaignState;
}

export class ApprovalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

const codeOf = (err: unknown) => {
  const c = (err as { code?: unknown })?.code;
  return typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : "UNKNOWN";
};

async function audit(db: SqlExecutor, row: Record<string, any>, action: string, actor: { userId?: string; label?: string }, metadata: object) {
  await db.query(
    `insert into public.audit_log (workspace_id, actor_kind, actor_user_id, actor_label, action, entity_type, entity_id, metadata)
     values ($1, $2, $3, $4, $5, 'approval_request', $6, $7)`,
    [row.workspace_id, actor.userId ? "user" : "system", actor.userId ?? null, actor.userId ? null : actor.label ?? "executor",
      action, row.id, JSON.stringify(metadata)],
  );
}

function defaultWriter(db: SqlExecutor, adAccountId: string) {
  return (account: { platform: string; external_id: string }): CampaignWriter => {
    if (account.platform !== "tiktok") throw new ApprovalError("PLATFORM_NOT_SUPPORTED", `No campaign writer for ${account.platform}`);
    if (account.external_id === DEMO_EXTERNAL_ID) {
      return new DemoCampaignWriter(async (campaignId) => {
        const [last] = await db.query(
          `select after_state from public.approval_requests
           where ad_account_id = $1 and target_id = $2 and status in ('executed', 'undone') and after_state is not null
           order by executed_at desc limit 1`,
          [adAccountId, campaignId],
        );
        return (last?.after_state as CampaignState | undefined) ?? null;
      });
    }
    return new TikTokCampaignWriter();
  };
}

/**
 * The writer and target for one campaign of an ad account: checks the account
 * is active and has a currency, and reads its token from the secret store
 * (never for the demo account). Shared by the executor and the suggestion rules.
 */
export async function campaignAccess(
  deps: ExecutorDeps,
  adAccountId: string,
  campaignId: string,
): Promise<{ writer: CampaignWriter; target: CampaignTarget; currency: string }> {
  const [account] = await deps.db.query(
    "select id, platform, external_id, currency, status from public.ad_accounts where id = $1",
    [adAccountId],
  );
  if (!account) throw new ApprovalError("ACCOUNT_NOT_FOUND", "Ad account not found");
  if (account.status !== "active") throw new ApprovalError("ACCOUNT_NOT_ACTIVE", "Ad account is not active");
  if (!account.currency) throw new ApprovalError("ACCOUNT_NO_CURRENCY", "Ad account has no currency");
  let accessToken = "";
  if (account.external_id !== DEMO_EXTERNAL_ID) {
    const [cred] = await deps.db.query("select secret_ref from public.ad_account_credentials where ad_account_id = $1", [account.id]);
    if (!cred) throw new ApprovalError("NO_CREDENTIALS", "Ad account has no credentials");
    accessToken = await deps.secrets.get(cred.secret_ref);
  }
  const writer = (deps.writerFor ?? defaultWriter(deps.db, account.id))(account as { platform: string; external_id: string });
  return { writer, target: { accessToken, advertiserId: account.external_id, campaignId, currency: account.currency }, currency: account.currency };
}

function applied(before: CampaignState, kind: string, payload: Record<string, unknown>): CampaignState {
  if (kind === "campaign.pause") return { ...before, status: "DISABLE" };
  if (kind === "campaign.enable") return { ...before, status: "ENABLE" };
  return { ...before, budgetMinor: String(payload.budget_minor) };
}

export async function executeApproval(
  deps: ExecutorDeps,
  args: { approvalId: string; executedBy?: string; executedByLabel?: string },
): Promise<ExecuteResult> {
  const row = await deps.db.transaction(async (q) => {
    const [r] = await q(
      `select id, workspace_id, client_id, kind, payload, status, ad_account_id, target_id, undo_of
       from public.approval_requests where id = $1 for update`,
      [args.approvalId],
    );
    if (!r) throw new ApprovalError("APPROVAL_NOT_FOUND", "Approval request not found");
    if (r.status !== "approved") throw new ApprovalError("APPROVAL_NOT_APPROVED", `Approval request is ${r.status}`);
    if (!["campaign.pause", "campaign.enable", "campaign.budget"].includes(r.kind)) {
      throw new ApprovalError("KIND_NOT_SUPPORTED", `Cannot execute ${r.kind}`);
    }
    await q("update public.approval_requests set status = 'executing' where id = $1", [r.id]);
    return r;
  });
  const actor = { userId: args.executedBy, label: args.executedByLabel };
  let before: CampaignState | undefined;

  try {
    const { writer, target } = await campaignAccess(deps, row.ad_account_id, row.target_id);

    before = await writer.getCampaign(target);

    if (row.kind === "campaign.budget") {
      const next = BigInt(String(row.payload.budget_minor));
      if (before.budgetMinor === null) throw new ApprovalError("BUDGET_NOT_DAILY", "Campaign has no daily budget to change");
      const [g] = await deps.db.query(
        "select max_daily_budget_minor::text as max, max_budget_increase_pct as pct from public.client_guardrails where client_id = $1",
        [row.client_id],
      );
      if (g?.max && next > BigInt(g.max)) throw new ApprovalError("GUARDRAIL_MAX_DAILY_BUDGET", "Above the client's maximum daily budget");
      const pct = BigInt(g?.pct ?? 50);
      const current = BigInt(before.budgetMinor);
      if (!row.undo_of && next > current && (next - current) * 100n > current * pct) {
        throw new ApprovalError("GUARDRAIL_MAX_INCREASE", "Above the client's maximum budget increase per change");
      }
      await writer.setDailyBudget(target, String(next));
    } else {
      await writer.setStatus(target, row.kind === "campaign.pause" ? "DISABLE" : "ENABLE");
    }

    const after = writer instanceof DemoCampaignWriter ? applied(before, row.kind, row.payload) : await writer.getCampaign(target);
    await deps.db.transaction(async (q) => {
      await q(
        `update public.approval_requests
         set status = 'executed', before_state = $2, after_state = $3, executed_by = $4, executed_at = now(), error_code = null
         where id = $1`,
        [row.id, JSON.stringify(before), JSON.stringify(after), args.executedBy ?? null],
      );
      if (row.undo_of) await q("update public.approval_requests set status = 'undone' where id = $1 and status = 'executed'", [row.undo_of]);
    });
    await audit(deps.db, row, "approval.executed", actor, { kind: row.kind, target_id: row.target_id, undo_of: row.undo_of ?? undefined });
    return { status: "executed", before, after };
  } catch (err) {
    const code = codeOf(err);
    await deps.db.query(
      "update public.approval_requests set status = 'failed', error_code = $2, before_state = coalesce($3::jsonb, before_state) where id = $1",
      [row.id, code, before ? JSON.stringify(before) : null],
    );
    await audit(deps.db, row, "approval.failed", actor, { kind: row.kind, target_id: row.target_id, error_code: code });
    return { status: "failed", errorCode: code, before };
  }
}

/** Undo an executed change by restoring its saved before-state (decided and executed as `userId`). */
export async function undoApproval(
  deps: ExecutorDeps,
  args: { approvalId: string; userId: string },
): Promise<ExecuteResult & { undoId: string }> {
  const [orig] = await deps.db.query(
    `select id, workspace_id, client_id, kind, status, ad_account_id, target_type, target_id, target_name, before_state
     from public.approval_requests where id = $1`,
    [args.approvalId],
  );
  if (!orig) throw new ApprovalError("APPROVAL_NOT_FOUND", "Approval request not found");
  if (orig.status !== "executed") throw new ApprovalError("UNDO_NOT_EXECUTED", `Only executed changes can be undone (this one is ${orig.status})`);
  const before = orig.before_state as CampaignState | null;
  let kind: string;
  let payload: Record<string, string> = {};
  if (orig.kind === "campaign.budget") {
    if (!before?.budgetMinor) throw new ApprovalError("UNDO_NOT_POSSIBLE", "No previous budget recorded");
    kind = "campaign.budget";
    payload = { budget_minor: before.budgetMinor };
  } else {
    if (before?.status !== "ENABLE" && before?.status !== "DISABLE") throw new ApprovalError("UNDO_NOT_POSSIBLE", "No previous status recorded");
    kind = before.status === "ENABLE" ? "campaign.enable" : "campaign.pause";
  }
  const undo = await deps.db.transaction(async (q) => {
    const [locked] = await q("select status from public.approval_requests where id = $1 for update", [orig.id]);
    if (locked?.status !== "executed") throw new ApprovalError("UNDO_NOT_EXECUTED", "Already undone or changed");
    const [open] = await q(
      "select 1 from public.approval_requests where undo_of = $1 and status in ('approved', 'executing', 'executed') limit 1",
      [orig.id],
    );
    if (open) throw new ApprovalError("UNDO_IN_PROGRESS", "An undo for this change already exists");
    const [created] = await q(
      `insert into public.approval_requests
         (workspace_id, client_id, kind, payload, status, requested_by, decided_by, decided_at, decision_note,
          ad_account_id, target_type, target_id, target_name, reason, undo_of)
       values ($1, $2, $3, $4, 'approved', $5, $5, now(), 'undo', $6, $7, $8, $9, $10, $11) returning id`,
      [orig.workspace_id, orig.client_id, kind, JSON.stringify(payload), args.userId, orig.ad_account_id, orig.target_type,
        orig.target_id, orig.target_name, "Undo: restore the state before the earlier change", orig.id],
    );
    return created!;
  });
  await audit(deps.db, { workspace_id: orig.workspace_id, id: undo!.id }, "approval.undo_requested", { userId: args.userId }, { undo_of: orig.id, kind });
  const result = await executeApproval(deps, { approvalId: undo!.id, executedBy: args.userId });
  return { ...result, undoId: undo!.id };
}
