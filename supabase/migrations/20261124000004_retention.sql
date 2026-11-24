-- =============================================================================
-- 0013  Data retention
--
--   purge_expired_data()  run daily by the server. Deletes personal data that
--                         is no longer needed:
--                           - invitations (email addresses) 90 days after they
--                             were accepted, cancelled or expired;
--                           - report delivery log rows (recipient addresses)
--                             older than 24 months.
--                         Returns what it deleted, per table.
--   The delivery log stays append-only for everyone else: its guard now lets
--   only this function delete old rows, and the server role loses its (unused)
--   delete grant. The audit log is NOT touched (append-only by design).
--   Client data is deleted with the client (owners, from the client page).
-- =============================================================================

-- The log guard also allows a delete when the purge function has marked this table.
create or replace function public.block_mutation_except_cascade() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op = 'DELETE' and current_setting('glio.retention_purge', true) = tg_table_name then
    return old;
  end if;
  raise exception '% is a log and cannot be changed (% blocked)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

revoke delete on public.report_deliveries from service_role;

create function public.purge_expired_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_invitations integer;
  n_deliveries  integer;
begin
  delete from public.invitations
   where coalesce(accepted_at, revoked_at, expires_at) < now() - interval '90 days';
  get diagnostics n_invitations = row_count;

  perform set_config('glio.retention_purge', 'report_deliveries', true);
  delete from public.report_deliveries where created_at < now() - interval '24 months';
  get diagnostics n_deliveries = row_count;
  perform set_config('glio.retention_purge', '', true);

  return jsonb_build_object('invitations', n_invitations, 'report_deliveries', n_deliveries);
end;
$$;
revoke all on function public.purge_expired_data() from public, anon, authenticated;
grant execute on function public.purge_expired_data() to service_role;
