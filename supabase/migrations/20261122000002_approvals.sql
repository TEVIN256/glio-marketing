-- =============================================================================
-- 0007  Approvals that can be executed (M7)
--
--   approval_requests  gains what an executable change needs: the ad account and
--                      campaign it targets, why it was proposed, the platform's
--                      state right before and after execution, who executed it,
--                      the error if it failed, the request it undoes, and an
--                      expiry. Statuses add executing / failed / undone.
--                      Decisions go ONLY through decide_approval() (role and
--                      status checked, audited); users can no longer update rows
--                      directly. Execution fields are written only by the server.
--   client_guardrails  per-client limits the executor enforces: a maximum daily
--                      budget and a maximum increase per change. Owners edit.
-- =============================================================================

alter table public.approval_requests
  add column ad_account_id uuid,
  add column target_type   text check (target_type in ('campaign')),
  add column target_id     text,
  add column target_name   text,
  add column reason        text check (length(reason) <= 1000),
  add column before_state  jsonb,
  add column after_state   jsonb,
  add column executed_by   uuid references auth.users (id),
  add column executed_at   timestamptz,
  add column error_code    text,
  add column undo_of       uuid references public.approval_requests (id),
  add column expires_at    timestamptz default (now() + interval '7 days');

alter table public.approval_requests
  add constraint approval_requests_account_fk
    foreign key (workspace_id, client_id, ad_account_id) references public.ad_accounts (workspace_id, client_id, id) on delete cascade,
  add constraint approval_requests_kind_check
    check (kind in ('campaign.launch', 'campaign.pause', 'campaign.enable', 'campaign.budget')),
  add constraint approval_requests_target_check
    check (kind = 'campaign.launch' or (ad_account_id is not null and target_type = 'campaign' and target_id is not null)),
  add constraint approval_requests_budget_check
    check (kind <> 'campaign.budget' or (payload ->> 'budget_minor') ~ '^[1-9][0-9]{0,15}$');

alter table public.approval_requests drop constraint approval_requests_status_check;
alter table public.approval_requests add constraint approval_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'executing', 'executed', 'failed', 'undone'));

create index approval_requests_client_idx on public.approval_requests (workspace_id, client_id, created_at desc);

-- Users propose (pending, as themselves, no execution fields); they never update rows directly.
drop policy approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager', 'analyst'])
              and requested_by = auth.uid() and requested_by_agent is null
              and status = 'pending' and decided_by is null and decided_at is null
              and before_state is null and after_state is null and executed_by is null and executed_at is null
              and error_code is null and undo_of is null);
drop policy approval_requests_update on public.approval_requests;
revoke update on public.approval_requests from authenticated;

-- The only way a user decides: owners and managers, pending and not expired, audited.
create function public.decide_approval(p_id uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.approval_requests;
begin
  select * into r from public.approval_requests where id = p_id for update;
  if r.id is null or not public.can_see_client(r.workspace_id, r.client_id) then
    raise exception 'approval request not found' using errcode = 'P0002';
  end if;
  if not public.has_ws_role(r.workspace_id, array['owner', 'manager']) then
    raise exception 'only owners and managers decide' using errcode = '42501';
  end if;
  if r.status <> 'pending' then
    raise exception 'approval request is %', r.status using errcode = '55000';
  end if;
  if r.expires_at is not null and r.expires_at < now() then
    update public.approval_requests set status = 'expired' where id = p_id;
    return 'expired';
  end if;
  update public.approval_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = left(p_note, 500)
   where id = p_id;
  insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
  values (r.workspace_id, 'user', auth.uid(),
          case when p_approve then 'approval.approved' else 'approval.rejected' end,
          'approval_request', p_id::text,
          jsonb_build_object('kind', r.kind, 'client_id', r.client_id, 'target_id', r.target_id));
  return case when p_approve then 'approved' else 'rejected' end;
end;
$$;
revoke all on function public.decide_approval(uuid, boolean, text) from public, anon;
grant execute on function public.decide_approval(uuid, boolean, text) to authenticated;

create table public.client_guardrails (
  client_id                 uuid primary key,
  workspace_id              uuid not null,
  max_daily_budget_minor    bigint check (max_daily_budget_minor > 0),
  max_budget_increase_pct   integer not null default 50 check (max_budget_increase_pct between 1 and 1000),
  updated_by                uuid references auth.users (id),
  updated_at                timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);
alter table public.client_guardrails enable row level security;
create policy client_guardrails_select on public.client_guardrails for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy client_guardrails_insert on public.client_guardrails for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner']));
create policy client_guardrails_update on public.client_guardrails for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner']))
  with check (public.has_ws_role(workspace_id, array['owner']));
create policy client_guardrails_delete on public.client_guardrails for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner']));
revoke all on public.client_guardrails from anon, authenticated;
grant select, insert, update, delete on public.client_guardrails to authenticated;
grant select on public.client_guardrails to service_role;
