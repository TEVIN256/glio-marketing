-- =============================================================================
-- 0012  One-click unsubscribe from report emails
--
--   report_deliveries.unsubscribe_token_hash
--                       every report email carries its own unsubscribe link;
--                       only the SHA-256 of the link's secret is stored, on
--                       the delivery row (which stays append-only).
--   report_unsubscribes people who stopped a client's report emails. Only the
--                       server writes it, when the person uses their link
--                       (unsubscribe, or subscribe again). Team members can
--                       see it but cannot add or remove anyone: the choice is
--                       the recipient's.
-- =============================================================================

alter table public.report_deliveries
  add column unsubscribe_token_hash text check (unsubscribe_token_hash ~ '^[0-9a-f]{64}$');
create unique index report_deliveries_unsubscribe_idx on public.report_deliveries (unsubscribe_token_hash)
  where unsubscribe_token_hash is not null;

create table public.report_unsubscribes (
  workspace_id    uuid not null,
  client_id       uuid not null,
  email           text not null check (email = lower(email) and public.all_emails(array[email])),
  unsubscribed_at timestamptz not null default now(),
  primary key (client_id, email),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);

alter table public.report_unsubscribes enable row level security;
create policy report_unsubscribes_select on public.report_unsubscribes for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
-- no insert/update/delete policies: only the recipient (through the server) changes it

revoke all on public.report_unsubscribes from anon, authenticated;
grant select on public.report_unsubscribes to authenticated;
grant select, insert, delete on public.report_unsubscribes to service_role;
