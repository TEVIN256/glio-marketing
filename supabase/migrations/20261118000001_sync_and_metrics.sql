-- =============================================================================
-- 0003  Sync runs, raw platform payloads, daily metrics (M2)
--
-- Every number Glio shows must trace back to what the platform returned:
--
--   sync_runs              one row per sync attempt (scheduled/backfill/manual)
--   raw_platform_payloads  every API response page, stored unchanged with a
--                          SHA-256 of its canonical JSON. Immutable: updates
--                          are blocked, and rows can only disappear through a
--                          cascade when their ad account/workspace is deleted.
--                          Identical responses are stored once per account.
--   metric_daily           query-friendly daily numbers per entity, each row
--                          pointing at the raw payload it came from. Upserted
--                          on (ad_account_id, level, entity_id, date), so
--                          re-running a sync never creates duplicates.
--
-- NULL metric = "not provided by platform" (never silently 0).
-- Money is stored in minor units (halalas for SAR) as bigint; never floats.
--
-- Signed-in users can only READ these tables (scoped by client visibility);
-- only the server (service_role) writes them.
-- =============================================================================

-- Lets child tables carry client_id with a guarantee it matches the account.
alter table public.ad_accounts
  add constraint ad_accounts_ws_client_id_key unique (workspace_id, client_id, id);

create table public.sync_runs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  client_id      uuid not null,
  ad_account_id  uuid not null,
  platform       text not null check (platform in ('tiktok', 'snapchat', 'meta', 'google_ads', 'google_business_profile')),
  kind           text not null check (kind in ('scheduled', 'backfill', 'manual')),
  date_from      date not null,
  date_to        date not null,
  status         text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  pages_fetched  integer not null default 0 check (pages_fetched >= 0),
  rows_written   integer not null default 0 check (rows_written >= 0),
  error_code     text,
  error_message  text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  check (date_to >= date_from),
  foreign key (workspace_id, client_id, ad_account_id)
    references public.ad_accounts (workspace_id, client_id, id) on delete cascade
);
create index sync_runs_account_idx on public.sync_runs (ad_account_id, started_at desc);

create table public.raw_platform_payloads (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null,
  client_id         uuid not null,
  ad_account_id     uuid not null,
  platform          text not null,
  endpoint          text not null,
  request_params    jsonb not null,          -- never contains credentials
  payload           jsonb not null,
  payload_sha256    text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  first_sync_run_id uuid not null references public.sync_runs (id),
  fetched_at        timestamptz not null default now(),
  foreign key (workspace_id, client_id, ad_account_id)
    references public.ad_accounts (workspace_id, client_id, id) on delete cascade,
  unique (ad_account_id, endpoint, payload_sha256)
);

create table public.metric_daily (
  workspace_id   uuid not null,
  client_id      uuid not null,
  ad_account_id  uuid not null,
  platform       text not null,
  level          text not null check (level in ('account', 'campaign', 'adgroup', 'ad')),
  entity_id      text not null,
  entity_name    text,
  date           date not null,
  currency       char(3) not null,
  spend_minor    bigint check (spend_minor >= 0),
  impressions    bigint check (impressions >= 0),
  clicks         bigint check (clicks >= 0),
  conversions    numeric(20, 4) check (conversions >= 0),
  raw_payload_id bigint not null references public.raw_platform_payloads (id),
  sync_run_id    uuid not null references public.sync_runs (id),
  updated_at     timestamptz not null default now(),
  primary key (ad_account_id, level, entity_id, date),
  foreign key (workspace_id, client_id, ad_account_id)
    references public.ad_accounts (workspace_id, client_id, id) on delete cascade
);
create index metric_daily_client_date_idx on public.metric_daily (workspace_id, client_id, date);

-- ---------------------------------------------------------------------------
-- Raw payloads are immutable. Direct deletes are blocked too; deletion only
-- happens through the ad_accounts ON DELETE CASCADE (account or workspace
-- removal, e.g. a PDPL deletion request), where the trigger runs nested.
-- ---------------------------------------------------------------------------

create function public.raw_payloads_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;  -- cascaded from deleting the ad account / workspace
  end if;
  raise exception 'raw_platform_payloads is immutable (% blocked)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger raw_payloads_no_update before update on public.raw_platform_payloads
  for each row execute function public.raw_payloads_block_mutation();
create trigger raw_payloads_no_direct_delete before delete on public.raw_platform_payloads
  for each row execute function public.raw_payloads_block_mutation();
create trigger raw_payloads_no_truncate before truncate on public.raw_platform_payloads
  for each statement execute function public.raw_payloads_block_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security: read-only for signed-in users, by client visibility.
-- No insert/update/delete policies: only the server writes.
-- ---------------------------------------------------------------------------

alter table public.sync_runs             enable row level security;
alter table public.raw_platform_payloads enable row level security;
alter table public.metric_daily          enable row level security;

create policy sync_runs_select on public.sync_runs for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy raw_platform_payloads_select on public.raw_platform_payloads for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy metric_daily_select on public.metric_daily for select to authenticated
  using (public.can_see_client(workspace_id, client_id));

revoke all on public.sync_runs, public.raw_platform_payloads, public.metric_daily from anon, authenticated;
grant select on public.sync_runs, public.raw_platform_payloads, public.metric_daily to authenticated;

grant select, insert, update, delete on public.sync_runs             to service_role;
grant select, insert, delete         on public.raw_platform_payloads to service_role;
grant select, insert, update, delete on public.metric_daily          to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function public.raw_payloads_block_mutation() from public, anon, authenticated;
