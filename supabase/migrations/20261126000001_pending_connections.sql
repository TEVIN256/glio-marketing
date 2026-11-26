-- =============================================================================
-- 0015  Choose which ad accounts to connect
--
--   pending_ad_connections  between TikTok's authorization and the owner's
--                           choice of accounts: who is connecting which client,
--                           the accounts TikTok authorised (ids, names, currency,
--                           time zone) and a REFERENCE to the token, which is
--                           already in Vault. Never the token itself.
--                           Server only (RLS on, no policies, no user grants),
--                           like ad_account_credentials. Expires after 30
--                           minutes; the daily job deletes expired rows and
--                           their unused tokens.
-- =============================================================================

create table public.pending_ad_connections (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id    uuid not null,
  user_id      uuid not null references auth.users (id) on delete cascade,
  platform     text not null check (platform in ('tiktok')),
  secret_ref   text not null,
  accounts     jsonb not null check (jsonb_typeof(accounts) = 'array'),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '30 minutes'),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);
create index pending_ad_connections_expiry_idx on public.pending_ad_connections (expires_at);

alter table public.pending_ad_connections enable row level security;
-- no policies: server only

revoke all on public.pending_ad_connections from anon, authenticated;
grant select, insert, delete on public.pending_ad_connections to service_role;
