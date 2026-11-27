-- =============================================================================
-- 0020  Store sales (Zid): what the store actually sold, next to ad-reported sales
--
--   store_connections  one e-commerce store per client and platform ('zid'),
--                      read-only. Everyone who can see the client reads it;
--                      only the server writes it.
--   store_credentials  SERVER ONLY (RLS on, no policies): a Vault reference
--                      for the store's tokens, never the tokens themselves,
--                      plus when they expire and were last refreshed.
--   store_payloads     the platform's order-list responses the figures were
--                      computed from, REDACTED before storage: only order id,
--                      created time, status, payment status, total, currency
--                      and source are kept; customer names, phones, emails
--                      and addresses are dropped (PDPL data minimisation).
--                      Immutable like raw_platform_payloads; deleted only by
--                      cascade (disconnecting, deleting the client/workspace).
--   store_sales_daily  per store per day (the store's time zone, by order
--                      creation): orders, gross sales, cancelled, refunded,
--                      net sales. Every row points at its payload.
-- =============================================================================

create table public.store_connections (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  client_id          uuid not null,
  platform           text not null check (platform in ('zid')),
  external_store_id  text not null check (length(external_store_id) between 1 and 100),
  name               text,
  currency           char(3),
  timezone           text,
  status             text not null default 'active' check (status in ('active', 'needs_reauth')),
  last_error_code    text,
  last_synced_at     timestamptz,
  connected_by       uuid,                       -- no FK to auth.users (ADR-037)
  connected_at       timestamptz not null default now(),
  unique (workspace_id, client_id, id),
  unique (client_id, platform),
  unique (workspace_id, platform, external_store_id),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

create table public.store_credentials (
  connection_id  uuid primary key references public.store_connections (id) on delete cascade,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  secret_ref     text not null,
  scopes         text[] not null default '{}',
  expires_at     timestamptz,
  refreshed_at   timestamptz not null default now()
);

create table public.store_payloads (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null,
  client_id       uuid not null,
  connection_id   uuid not null,
  platform        text not null,
  endpoint        text not null,
  request_params  jsonb not null,                -- never contains credentials
  payload         jsonb not null,                -- redacted: no customer details
  payload_sha256  text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at      timestamptz not null default now(),
  unique (connection_id, endpoint, payload_sha256),
  foreign key (workspace_id, client_id, connection_id)
    references public.store_connections (workspace_id, client_id, id) on delete cascade
);

create table public.store_sales_daily (
  workspace_id              uuid not null,
  client_id                 uuid not null,
  connection_id             uuid not null,
  platform                  text not null,
  date                      date not null,
  currency                  char(3) not null,
  orders                    integer not null check (orders >= 0),
  gross_sales_minor         bigint not null check (gross_sales_minor >= 0),
  cancelled_orders          integer not null check (cancelled_orders >= 0),
  refunded_orders           integer not null check (refunded_orders >= 0),
  refunded_minor            bigint not null check (refunded_minor >= 0),
  partially_refunded_orders integer not null check (partially_refunded_orders >= 0),
  net_sales_minor           bigint not null check (net_sales_minor >= 0),
  raw_payload_id            bigint not null references public.store_payloads (id),
  updated_at                timestamptz not null default now(),
  check (refunded_orders <= orders and refunded_minor <= gross_sales_minor
         and net_sales_minor = gross_sales_minor - refunded_minor),
  primary key (connection_id, date),
  foreign key (workspace_id, client_id, connection_id)
    references public.store_connections (workspace_id, client_id, id) on delete cascade
);
create index store_sales_daily_client_date_idx on public.store_sales_daily (client_id, date);

-- The payload archive is immutable; deletes only arrive by cascade.
create function public.store_payloads_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;  -- cascaded from disconnecting the store / deleting the client or workspace
  end if;
  raise exception 'store_payloads is immutable (% blocked)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;
create trigger store_payloads_no_update before update on public.store_payloads
  for each row execute function public.store_payloads_block_mutation();
create trigger store_payloads_no_direct_delete before delete on public.store_payloads
  for each row execute function public.store_payloads_block_mutation();
create trigger store_payloads_no_truncate before truncate on public.store_payloads
  for each statement execute function public.store_payloads_block_mutation();
revoke all on function public.store_payloads_block_mutation() from public, anon, authenticated;

alter table public.store_connections enable row level security;
alter table public.store_credentials enable row level security;
alter table public.store_payloads    enable row level security;
alter table public.store_sales_daily enable row level security;

create policy store_connections_select on public.store_connections for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy store_payloads_select on public.store_payloads for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy store_sales_daily_select on public.store_sales_daily for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
-- store_credentials: no policies at all (server only).

revoke all on public.store_connections, public.store_credentials, public.store_payloads, public.store_sales_daily
  from anon, authenticated;
grant select on public.store_connections, public.store_payloads, public.store_sales_daily to authenticated;

grant select, insert, update, delete on public.store_connections to service_role;
grant select, insert, update, delete on public.store_credentials to service_role;
grant select, insert, delete         on public.store_payloads    to service_role;
grant select, insert, update, delete on public.store_sales_daily to service_role;
