-- =============================================================================
-- 0001  Tenancy foundation (M1)
--
-- Workspace (a business or an agency) -> clients -> ad accounts.
-- Every row carries workspace_id; row-level security (RLS) is enabled on every
-- table, and policies decide access from the caller's membership.
--
-- Roles (memberships.role):
--   owner          full control of the workspace
--   manager        manages clients, ad accounts, approvals
--   analyst        reads everything in the workspace, proposes actions
--   client_viewer  sees ONE client only (memberships.client_id)
--
-- Also created now, empty, so later stages need no redesign:
--   approval_requests  every future write action goes through here
--   audit_log          append-only; updates/deletes are blocked by trigger
--
-- Platform credentials never live in a table users can read:
--   ad_account_credentials has RLS on and NO policies, so only the server
--   (service role) can read it, and it stores a reference into the secret
--   store, never the token itself.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('business', 'agency')),
  name             text not null check (length(btrim(name)) between 1 and 200),
  default_currency char(3) not null default 'SAR',
  timezone         text not null default 'Asia/Riyadh',
  locale           text not null default 'ar' check (locale in ('ar', 'en')),
  created_at       timestamptz not null default now()
);

create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 200),
  currency     char(3) not null default 'SAR',
  timezone     text not null default 'Asia/Riyadh',
  created_at   timestamptz not null default now(),
  -- lets child tables use a composite FK so a row can never point at a
  -- client in a different workspace
  unique (workspace_id, id)
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null check (role in ('owner', 'manager', 'analyst', 'client_viewer')),
  client_id    uuid,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  -- a client_viewer is always tied to exactly one client; other roles never are
  check ((role = 'client_viewer') = (client_id is not null))
);
create index memberships_user_idx on public.memberships (user_id);

create table public.ad_accounts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id    uuid not null,
  platform     text not null check (platform in ('tiktok', 'snapchat', 'meta', 'google_ads', 'google_business_profile')),
  external_id  text not null check (length(btrim(external_id)) > 0),
  name         text,
  currency     char(3),
  timezone     text,
  status       text not null default 'pending' check (status in ('pending', 'active', 'disconnected', 'error')),
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  unique (workspace_id, platform, external_id),
  unique (workspace_id, id)
);
create index ad_accounts_client_idx on public.ad_accounts (workspace_id, client_id);

create table public.ad_account_credentials (
  ad_account_id uuid primary key,
  workspace_id  uuid not null,
  secret_ref    text not null,          -- pointer into the secret store; never the token
  scopes        text[] not null default '{}',
  expires_at    timestamptz,
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, ad_account_id) references public.ad_accounts (workspace_id, id) on delete cascade
);

create table public.approval_requests (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  client_id          uuid not null,
  kind               text not null,                 -- e.g. 'campaign.launch', 'adgroup.budget_change'
  payload            jsonb not null default '{}'::jsonb,
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'rejected', 'expired', 'executed')),
  requested_by       uuid references auth.users (id),
  requested_by_agent text,                          -- set when an AI agent or rule proposed it
  decided_by         uuid references auth.users (id),
  decided_at         timestamptz,
  decision_note      text,
  created_at         timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  check (requested_by is not null or requested_by_agent is not null)
);
create index approval_requests_ws_idx on public.approval_requests (workspace_id, status);

-- No FK to workspaces on purpose: audit history must survive workspace deletion
-- until the retention policy (COMPLIANCE.md) says otherwise.
create table public.audit_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null,
  actor_kind    text not null check (actor_kind in ('user', 'agent', 'system')),
  actor_user_id uuid,
  actor_label   text,                               -- agent/system name when not a user
  action        text not null,                      -- e.g. 'workspace.created', 'client.viewed'
  entity_type   text,
  entity_id     text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  check ((actor_kind = 'user') = (actor_user_id is not null))
);
create index audit_log_ws_idx on public.audit_log (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit log is append-only, for everyone (triggers fire even for the service
-- role, which bypasses RLS).
-- ---------------------------------------------------------------------------

create function public.audit_log_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only (% blocked)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update before update on public.audit_log
  for each row execute function public.audit_log_block_mutation();
create trigger audit_log_no_delete before delete on public.audit_log
  for each row execute function public.audit_log_block_mutation();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- Access helpers. SECURITY DEFINER so policies can consult memberships without
-- recursing through memberships' own RLS. They only ever answer about the
-- calling user (auth.uid()).
-- ---------------------------------------------------------------------------

create function public.ws_role(ws uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  where m.workspace_id = ws and m.user_id = auth.uid()
$$;

create function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.ws_role(ws) is not null
$$;

create function public.has_ws_role(ws uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.ws_role(ws) = any (roles), false)
$$;

-- Staff (owner/manager/analyst) see every client in their workspace;
-- a client_viewer sees only the client on their membership.
create function public.can_see_client(ws uuid, cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and (m.role in ('owner', 'manager', 'analyst')
           or (m.role = 'client_viewer' and m.client_id = cid))
  )
$$;

-- ---------------------------------------------------------------------------
-- Creating a workspace: the only way in. Creates the workspace, makes the
-- caller its owner, creates the business's own client record for
-- kind='business', and writes the audit entry, all in one transaction.
-- ---------------------------------------------------------------------------

create function public.create_workspace(p_name text, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_ws   uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  insert into public.workspaces (kind, name) values (p_kind, p_name)
  returning id into v_ws;

  insert into public.memberships (workspace_id, user_id, role)
  values (v_ws, v_user, 'owner');

  if p_kind = 'business' then
    insert into public.clients (workspace_id, name) values (v_ws, p_name);
  end if;

  insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id)
  values (v_ws, 'user', v_user, 'workspace.created', 'workspace', v_ws::text);

  return v_ws;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.workspaces             enable row level security;
alter table public.clients                enable row level security;
alter table public.memberships            enable row level security;
alter table public.ad_accounts            enable row level security;
alter table public.ad_account_credentials enable row level security;
alter table public.approval_requests      enable row level security;
alter table public.audit_log              enable row level security;

-- workspaces: created only via create_workspace()
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_ws_role(id, array['owner'])) with check (public.has_ws_role(id, array['owner']));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.has_ws_role(id, array['owner']));

-- clients
create policy clients_select on public.clients for select to authenticated
  using (public.can_see_client(workspace_id, id));
create policy clients_insert on public.clients for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy clients_update on public.clients for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy clients_delete on public.clients for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner']));

-- memberships: you see your own row; owners/managers see the team.
-- Only owners change membership, and never their own row (no self-promotion,
-- no locking yourself out).
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner']) and user_id <> auth.uid());
create policy memberships_update on public.memberships for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner']) and user_id <> auth.uid())
  with check (public.has_ws_role(workspace_id, array['owner']) and user_id <> auth.uid());
create policy memberships_delete on public.memberships for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner']) and user_id <> auth.uid());

-- ad_accounts
create policy ad_accounts_select on public.ad_accounts for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy ad_accounts_insert on public.ad_accounts for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy ad_accounts_update on public.ad_accounts for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy ad_accounts_delete on public.ad_accounts for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']));

-- ad_account_credentials: RLS on, deliberately NO policies -> server only.

-- approval_requests (empty in Stage 1; shape is fixed now)
create policy approval_requests_select on public.approval_requests for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy approval_requests_insert on public.approval_requests for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager', 'analyst'])
              and requested_by = auth.uid() and requested_by_agent is null
              and status = 'pending' and decided_by is null);
create policy approval_requests_update on public.approval_requests for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
-- no delete policy: approvals are history

-- audit_log: owners/managers read their workspace's log; users may only add
-- entries as themselves. Agents/system write through the server.
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy audit_log_insert on public.audit_log for insert to authenticated
  with check (actor_kind = 'user' and actor_user_id = auth.uid() and public.is_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Grants. Supabase grants broadly by default; we state exactly what the
-- signed-in role needs and give the anonymous role nothing.
-- ---------------------------------------------------------------------------

revoke all on public.workspaces, public.clients, public.memberships, public.ad_accounts,
              public.ad_account_credentials, public.approval_requests, public.audit_log
  from anon, authenticated;

grant select, update, delete         on public.workspaces        to authenticated;
grant select, insert, update, delete on public.clients           to authenticated;
grant select, insert, update, delete on public.memberships       to authenticated;
grant select, insert, update, delete on public.ad_accounts       to authenticated;
grant select, insert, update         on public.approval_requests to authenticated;
grant select, insert                 on public.audit_log         to authenticated;
-- ad_account_credentials: no grants to anon/authenticated at all

revoke all on function public.ws_role(uuid), public.is_member(uuid), public.has_ws_role(uuid, text[]),
                       public.can_see_client(uuid, uuid), public.create_workspace(text, text),
                       public.audit_log_block_mutation()
  from public, anon;
grant execute on function public.ws_role(uuid), public.is_member(uuid), public.has_ws_role(uuid, text[]),
                          public.can_see_client(uuid, uuid), public.create_workspace(text, text)
  to authenticated, service_role;
