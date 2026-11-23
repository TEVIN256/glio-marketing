-- =============================================================================
-- 0008  Approval notifications (email)
--
--   approval_requests.notified_at  when owners/managers were emailed about this
--                                  request; each request is announced once.
--                                  Written only by the server.
--   notification_settings          per person and workspace: whether they want
--                                  "changes waiting for approval" emails.
--                                  No row = yes. Each person edits only their own.
-- =============================================================================

alter table public.approval_requests add column notified_at timestamptz;

create index approval_requests_unnotified_idx on public.approval_requests (workspace_id)
  where status = 'pending' and notified_at is null;

-- Users still can't set server-only fields when proposing (now including notified_at).
drop policy approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager', 'analyst'])
              and requested_by = auth.uid() and requested_by_agent is null
              and status = 'pending' and decided_by is null and decided_at is null
              and before_state is null and after_state is null and executed_by is null and executed_at is null
              and error_code is null and undo_of is null and notified_at is null);

create table public.notification_settings (
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  approvals_email boolean not null default true,
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
alter table public.notification_settings enable row level security;
create policy notification_settings_select on public.notification_settings for select to authenticated
  using (user_id = auth.uid() and public.is_member(workspace_id));
create policy notification_settings_insert on public.notification_settings for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy notification_settings_update on public.notification_settings for update to authenticated
  using (user_id = auth.uid() and public.is_member(workspace_id))
  with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy notification_settings_delete on public.notification_settings for delete to authenticated
  using (user_id = auth.uid());
revoke all on public.notification_settings from anon, authenticated;
grant select, insert, update, delete on public.notification_settings to authenticated;
grant select on public.notification_settings to service_role;
