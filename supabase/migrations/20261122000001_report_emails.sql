-- =============================================================================
-- 0006  Emailed reports (M6)
--
--   report_schedules   one row per client: who receives the client's report,
--                      how often (off / weekly / monthly), on which weekday,
--                      and in which language. Owners and managers edit it;
--                      everyone who can see the client can read it.
--   report_deliveries  a permanent log of every report email: which snapshot
--                      (exactly what was sent), which period, to whom, whether
--                      it was sent or failed, and the provider's message id.
--                      Only the server writes it. A scheduled report is sent at
--                      most once per client, period and recipient (unique index).
-- =============================================================================

-- Every recipient must look like an email address (letters checked by the app too).
create function public.all_emails(addresses text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(a ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(a) <= 254), true)
  from unnest(addresses) as a
$$;

create table public.report_schedules (
  client_id    uuid primary key,
  workspace_id uuid not null,
  frequency    text not null default 'off' check (frequency in ('off', 'weekly', 'monthly')),
  send_weekday smallint not null default 7 check (send_weekday between 1 and 7), -- ISO: 1 = Monday ... 7 = Sunday
  language     text not null default 'ar' check (language in ('ar', 'en')),
  recipients   text[] not null default '{}' check (cardinality(recipients) <= 20 and public.all_emails(recipients)),
  updated_by   uuid references auth.users (id),
  updated_at   timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

create table public.report_deliveries (
  id                  bigint generated always as identity primary key,
  workspace_id        uuid not null,
  client_id           uuid not null,
  snapshot_id         uuid references public.report_snapshots (id) on delete cascade,
  period_from         date not null,
  period_to           date not null,
  recipient           text not null,
  trigger             text not null check (trigger in ('schedule', 'manual')),
  status              text not null check (status in ('sent', 'failed')),
  provider            text not null default 'resend',
  provider_message_id text,
  error_code          text,
  sent_by             uuid references auth.users (id),
  created_at          timestamptz not null default now(),
  check (period_to >= period_from),
  check (status = 'failed' or snapshot_id is not null),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);
create index report_deliveries_client_idx on public.report_deliveries (workspace_id, client_id, created_at desc);
create unique index report_deliveries_scheduled_once on public.report_deliveries (client_id, period_from, period_to, recipient)
  where trigger = 'schedule' and status = 'sent';

-- The delivery log is permanent (guard function from migration 0004).
create trigger report_deliveries_no_update before update on public.report_deliveries
  for each row execute function public.block_mutation_except_cascade();
create trigger report_deliveries_no_direct_delete before delete on public.report_deliveries
  for each row execute function public.block_mutation_except_cascade();
create trigger report_deliveries_no_truncate before truncate on public.report_deliveries
  for each statement execute function public.block_mutation_except_cascade();

alter table public.report_schedules  enable row level security;
alter table public.report_deliveries enable row level security;

create policy report_schedules_select on public.report_schedules for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy report_schedules_insert on public.report_schedules for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy report_schedules_update on public.report_schedules for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']))
  with check (public.has_ws_role(workspace_id, array['owner', 'manager']));
create policy report_schedules_delete on public.report_schedules for delete to authenticated
  using (public.has_ws_role(workspace_id, array['owner', 'manager']));

create policy report_deliveries_select on public.report_deliveries for select to authenticated
  using (public.can_see_client(workspace_id, client_id));

revoke all on public.report_schedules, public.report_deliveries from anon, authenticated;
grant select, insert, update, delete on public.report_schedules to authenticated;
grant select on public.report_deliveries to authenticated;
grant select on public.report_schedules to service_role;
grant select, insert, delete on public.report_deliveries to service_role;
grant usage on sequence public.report_deliveries_id_seq to service_role;
revoke all on function public.all_emails(text[]) from public, anon;
grant execute on function public.all_emails(text[]) to authenticated, service_role;
