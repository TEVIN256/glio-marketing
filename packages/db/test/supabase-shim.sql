-- TEST ONLY. Never run against a real Supabase project.
--
-- Recreates the small part of Supabase that our migrations depend on, so the
-- tenancy tests can run against plain Postgres (locally and in CI):
--   * roles: anon, authenticated, service_role
--   * auth.users
--   * auth.uid(), which reads the JWT claims the same way Supabase does
--
-- Tests impersonate a signed-in user with:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text unique
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Deliberately NO default privileges: this mirrors a Supabase project with
-- "Automatically expose new tables" turned off, so every grant Glio relies
-- on must be written explicitly in a migration.

-- The production server connects as `postgres` (DATABASE_URL), which can read
-- auth.users (e.g. owners' emails for approval notifications). Tests run the
-- server as service_role, so give it the same read access here.
grant select on auth.users to service_role;
