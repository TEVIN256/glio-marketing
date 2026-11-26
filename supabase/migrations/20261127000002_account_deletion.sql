-- =============================================================================
-- 0018  Deleting a user account
--
--   "Who did it" columns (requested_by, decided_by, executed_by, created_by,
--   updated_by, sent_by, invited_by, accepted_by) no longer reference
--   auth.users. When a person deletes their GLIO account, their sign-in record
--   (email, password) is deleted and these columns keep the bare id, exactly
--   like audit_log.actor_user_id already does: history stays intact and
--   append-only records are never rewritten, but nothing links the id back to
--   a person any more (shown as "former member").
--   Memberships, notification settings and pending connections still go with
--   the account (ON DELETE CASCADE).
-- =============================================================================

alter table public.approval_requests  drop constraint if exists approval_requests_decided_by_fkey;
alter table public.approval_requests  drop constraint if exists approval_requests_executed_by_fkey;
alter table public.approval_requests  drop constraint if exists approval_requests_requested_by_fkey;
alter table public.report_snapshots   drop constraint if exists report_snapshots_created_by_fkey;
alter table public.report_schedules   drop constraint if exists report_schedules_updated_by_fkey;
alter table public.report_deliveries  drop constraint if exists report_deliveries_sent_by_fkey;
alter table public.client_guardrails  drop constraint if exists client_guardrails_updated_by_fkey;
alter table public.invitations        drop constraint if exists invitations_accepted_by_fkey;
alter table public.invitations        drop constraint if exists invitations_invited_by_fkey;
alter table public.suggestion_settings drop constraint if exists suggestion_settings_updated_by_fkey;
alter table public.report_shares      drop constraint if exists report_shares_created_by_fkey;
alter table public.client_economics   drop constraint if exists client_economics_updated_by_fkey;

-- The server cancels a departing person's open invitations.
grant update (revoked_at) on public.invitations to service_role;
