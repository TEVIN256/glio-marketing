-- =============================================================================
-- 0016  Today so far (provisional, per hour and per campaign)
--
--   metric_intraday  TikTok's figures for TODAY (and yesterday's hours, for
--                    comparison), refreshed when the client page is viewed, at
--                    most every 10 minutes. PROVISIONAL: never used by
--                    reports, emails, share links or reconciliation; completed
--                    days come only from the daily sync (metric_daily).
--                    grain 'day'  = the day so far per campaign (incl. purchase value)
--                    grain 'hour' = per campaign per hour (TikTok gives no
--                                   purchase value per hour)
--   sync_runs.kind   may be 'intraday' (each refresh; its raw responses are
--                    archived like any other).
--   purge_expired_data() also deletes intraday rows older than 14 days, then
--                    the intraday runs' raw responses nothing else uses, then
--                    those runs (intraday refreshes would otherwise grow the
--                    raw archive all day long).
-- =============================================================================

alter table public.sync_runs drop constraint sync_runs_kind_check;
alter table public.sync_runs add constraint sync_runs_kind_check
  check (kind in ('scheduled', 'backfill', 'manual', 'intraday'));

create table public.metric_intraday (
  workspace_id          uuid not null,
  client_id             uuid not null,
  ad_account_id         uuid not null,
  platform              text not null,
  entity_id             text not null,
  entity_name           text,
  day                   date not null,                          -- in the ad account's time zone
  grain                 text not null check (grain in ('day', 'hour')),
  hour                  smallint not null check (hour between 0 and 23),
  currency              char(3) not null,
  spend_minor           bigint check (spend_minor >= 0),
  impressions           bigint check (impressions >= 0),
  clicks                bigint check (clicks >= 0),
  conversions           numeric(20, 4) check (conversions >= 0),
  purchase_value_minor  bigint check (purchase_value_minor >= 0),
  raw_payload_id        bigint not null references public.raw_platform_payloads (id),
  sync_run_id           uuid not null references public.sync_runs (id) on delete cascade,
  fetched_at            timestamptz not null default now(),
  check (grain = 'hour' or hour = 0),
  primary key (ad_account_id, entity_id, day, grain, hour),
  foreign key (workspace_id, client_id, ad_account_id)
    references public.ad_accounts (workspace_id, client_id, id) on delete cascade
);
create index metric_intraday_client_day_idx on public.metric_intraday (client_id, day);

alter table public.metric_intraday enable row level security;
create policy metric_intraday_select on public.metric_intraday for select to authenticated
  using (public.can_see_client(workspace_id, client_id));

revoke all on public.metric_intraday from anon, authenticated;
grant select on public.metric_intraday to authenticated;
grant select, insert, delete on public.metric_intraday to service_role;

-- The raw archive's guard also lets the retention purge delete old intraday responses.
create or replace function public.raw_payloads_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;  -- cascaded from deleting the ad account / workspace
  end if;
  if tg_op = 'DELETE' and current_setting('glio.retention_purge', true) = 'raw_platform_payloads' then
    return old;  -- purge_expired_data(): old intraday responses nothing references
  end if;
  raise exception 'raw_platform_payloads is immutable (% blocked)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create or replace function public.purge_expired_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_invitations integer;
  n_deliveries  integer;
  n_intraday    integer;
  n_payloads    integer;
begin
  delete from public.invitations
   where coalesce(accepted_at, revoked_at, expires_at) < now() - interval '90 days';
  get diagnostics n_invitations = row_count;

  perform set_config('glio.retention_purge', 'report_deliveries', true);
  delete from public.report_deliveries where created_at < now() - interval '24 months';
  get diagnostics n_deliveries = row_count;

  delete from public.metric_intraday where day < current_date - 14;
  get diagnostics n_intraday = row_count;

  perform set_config('glio.retention_purge', 'raw_platform_payloads', true);
  delete from public.raw_platform_payloads p
   using public.sync_runs s
   where s.id = p.first_sync_run_id and s.kind = 'intraday' and s.started_at < now() - interval '14 days'
     and not exists (select 1 from public.metric_intraday m where m.raw_payload_id = p.id)
     and not exists (select 1 from public.metric_daily m where m.raw_payload_id = p.id)
     and not exists (select 1 from public.reconciliation_checks r where r.platform_payload_id = p.id);
  get diagnostics n_payloads = row_count;
  perform set_config('glio.retention_purge', '', true);

  delete from public.sync_runs s
   where s.kind = 'intraday' and s.started_at < now() - interval '14 days'
     and not exists (select 1 from public.raw_platform_payloads p where p.first_sync_run_id = s.id);

  return jsonb_build_object('invitations', n_invitations, 'report_deliveries', n_deliveries,
                            'metric_intraday', n_intraday, 'intraday_payloads', n_payloads);
end;
$$;
revoke all on function public.purge_expired_data() from public, anon, authenticated;
grant execute on function public.purge_expired_data() to service_role;
