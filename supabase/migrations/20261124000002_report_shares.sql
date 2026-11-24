-- =============================================================================
-- 0011  Report share links
--
--   report_shares  a read-only link to ONE report snapshot for people without
--                  a GLIO account (e.g. the client). Only a SHA-256 of the
--                  link's secret is stored. Expires; owners/managers revoke.
--                  view_count / last_viewed_at are written by the server when
--                  the link is opened. Never deleted (history), except with
--                  the snapshot's client.
-- =============================================================================

-- Lets a share reference (workspace, client, snapshot) together, so a link can never
-- point at another client's report. Adds an index only; no snapshot row changes.
create unique index report_snapshots_ws_client_id_idx on public.report_snapshots (workspace_id, client_id, id);

create table public.report_shares (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  client_id        uuid not null,
  snapshot_id      uuid not null,
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by       uuid references auth.users (id),
  created_by_label text,                                  -- e.g. 'report-email' when not a person
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '30 days'),
  revoked_at       timestamptz,
  view_count       integer not null default 0,
  last_viewed_at   timestamptz,
  check (created_by is not null or created_by_label is not null),
  check (expires_at > created_at and expires_at <= created_at + interval '366 days'),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  foreign key (workspace_id, client_id, snapshot_id) references public.report_snapshots (workspace_id, client_id, id) on delete cascade
);
create index report_shares_snapshot_idx on public.report_shares (snapshot_id, created_at desc);

alter table public.report_shares enable row level security;
create policy report_shares_select on public.report_shares for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy report_shares_insert on public.report_shares for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']) and created_by = auth.uid()
              and created_by_label is null and revoked_at is null and view_count = 0 and last_viewed_at is null);
create policy report_shares_update on public.report_shares for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
-- no delete policy: links are history

revoke all on public.report_shares from anon, authenticated;
grant select, insert on public.report_shares to authenticated;
grant update (revoked_at) on public.report_shares to authenticated;    -- users can only revoke
grant select, insert on public.report_shares to service_role;
grant update (view_count, last_viewed_at) on public.report_shares to service_role;
