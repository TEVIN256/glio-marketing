-- =============================================================================
-- 0010  Per-client settings for GLIO suggestions
--
--   suggestion_settings  one row per client: whether GLIO suggests changes for
--                        it, and the thresholds the rules use. No row = the
--                        defaults (rules v1). Everyone who can see the client
--                        reads it; owners and managers edit it; the server reads it.
-- =============================================================================

create table public.suggestion_settings (
  client_id                 uuid primary key,
  workspace_id              uuid not null,
  enabled                   boolean not null default true,
  pause_min_spend_major     integer not null default 300 check (pause_min_spend_major between 10 and 1000000),
  high_cpa_pct              integer not null default 150 check (high_cpa_pct between 110 and 500),
  low_cpa_pct               integer not null default 70  check (low_cpa_pct between 10 and 95),
  min_conversions_for_cut   integer not null default 3   check (min_conversions_for_cut between 1 and 1000),
  min_conversions_for_raise integer not null default 10  check (min_conversions_for_raise between 1 and 1000),
  step_pct                  integer not null default 20  check (step_pct between 5 and 50),
  updated_by                uuid references auth.users (id),
  updated_at                timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

alter table public.suggestion_settings enable row level security;
create policy suggestion_settings_select on public.suggestion_settings for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy suggestion_settings_insert on public.suggestion_settings for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy suggestion_settings_update on public.suggestion_settings for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy suggestion_settings_delete on public.suggestion_settings for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']));

revoke all on public.suggestion_settings from anon, authenticated;
grant select, insert, update, delete on public.suggestion_settings to authenticated;
grant select on public.suggestion_settings to service_role;
