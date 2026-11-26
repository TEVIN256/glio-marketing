-- =============================================================================
-- 0017  Break-even ROAS
--
--   client_economics  one row per client: its approximate gross margin (the
--                     share of each sale left after product cost), entered by
--                     owners/managers. GLIO derives break-even ROAS = 100 /
--                     margin% and an estimated gross profit after ad spend.
--                     Everyone who can see the client reads it. No row = not set.
-- =============================================================================

create table public.client_economics (
  client_id        uuid primary key,
  workspace_id     uuid not null,
  gross_margin_pct numeric(5, 2) not null check (gross_margin_pct > 0 and gross_margin_pct <= 100),
  updated_by       uuid references auth.users (id),
  updated_at       timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

alter table public.client_economics enable row level security;
create policy client_economics_select on public.client_economics for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy client_economics_insert on public.client_economics for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy client_economics_update on public.client_economics for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy client_economics_delete on public.client_economics for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']));

revoke all on public.client_economics from anon, authenticated;
grant select, insert, update, delete on public.client_economics to authenticated;
grant select on public.client_economics to service_role;
