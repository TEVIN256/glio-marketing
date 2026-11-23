-- =============================================================================
-- 0009  Team invitations
--
--   invitations           an owner invites an email address to the workspace as
--                         manager, analyst or client_viewer (tied to one client).
--                         Only a SHA-256 of the link's secret is stored. Valid
--                         7 days; one open invite per workspace and email.
--                         Owners see and revoke them; nobody deletes them.
--   invitation_preview()  what the signed-in person was invited to, without
--                         joining (the invite page needs it before they are a member).
--   accept_invitation()   the only way to join through an invite: the signed-in
--                         person's (confirmed) email must equal the invited one.
-- =============================================================================

create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        text not null check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(email) <= 254),
  role         text not null check (role in ('manager', 'analyst', 'client_viewer')),
  client_id    uuid,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by   uuid not null references auth.users (id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id),
  revoked_at   timestamptz,
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  check ((role = 'client_viewer') = (client_id is not null))
);
create unique index invitations_one_open on public.invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

alter table public.invitations enable row level security;
create policy invitations_select on public.invitations for select to authenticated
  using (public.has_ws_role(workspace_id, array['owner']));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (public.has_ws_role(workspace_id, array['owner']) and invited_by = auth.uid()
              and accepted_at is null and accepted_by is null and revoked_at is null);
create policy invitations_update on public.invitations for update to authenticated
  using (public.has_ws_role(workspace_id, array['owner']))
  with check (public.has_ws_role(workspace_id, array['owner']));
-- no delete policy: invitations are history

revoke all on public.invitations from anon, authenticated;
grant select, insert on public.invitations to authenticated;
grant update (revoked_at) on public.invitations to authenticated;   -- owners can only revoke
grant select on public.invitations to service_role;

create function public.invitation_preview(p_token_hash text)
returns table (workspace_name text, role text, client_name text, invited_email text, status text)
language plpgsql stable security definer set search_path = '' as $$
declare
  me text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select lower(u.email) into me from auth.users u where u.id = auth.uid();
  return query
    select w.name, i.role, c.name,
           case when i.email = me then i.email
                else left(i.email, 1) || '***@' || split_part(i.email, '@', 2) end,
           case when i.accepted_at is not null then 'accepted'
                when i.revoked_at is not null then 'revoked'
                when i.expires_at < now() then 'expired'
                when i.email <> coalesce(me, '') then 'wrong_account'
                else 'open' end
    from public.invitations i
    join public.workspaces w on w.id = i.workspace_id
    left join public.clients c on c.id = i.client_id
    where i.token_hash = p_token_hash;
end;
$$;
revoke all on function public.invitation_preview(text) from public, anon;
grant execute on function public.invitation_preview(text) to authenticated;

create function public.accept_invitation(p_token_hash text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.invitations;
  me text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into i from public.invitations where token_hash = p_token_hash for update;
  if i.id is null then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if i.accepted_at is not null or i.revoked_at is not null or i.expires_at < now() then
    raise exception 'invitation is no longer valid' using errcode = '55000';
  end if;
  select lower(u.email) into me from auth.users u where u.id = auth.uid();
  if me is distinct from i.email then
    raise exception 'signed in with a different email than the one invited' using errcode = '42501';
  end if;
  -- Already a member: keep the current role (an invite never changes it).
  insert into public.memberships (workspace_id, user_id, role, client_id)
  values (i.workspace_id, auth.uid(), i.role, i.client_id)
  on conflict (workspace_id, user_id) do nothing;
  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = i.id;
  insert into public.audit_log (workspace_id, actor_kind, actor_user_id, action, entity_type, entity_id, metadata)
  values (i.workspace_id, 'user', auth.uid(), 'member.joined', 'invitation', i.id::text,
          jsonb_build_object('role', i.role, 'client_id', i.client_id, 'invited_by', i.invited_by));
  return i.workspace_id;
end;
$$;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;
