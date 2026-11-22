-- TEST ONLY. Never run against a real Supabase project (which has the real Vault).
-- A plain-table stand-in for Supabase Vault's interface: vault.secrets,
-- vault.decrypted_secrets, vault.create_secret(), vault.update_secret().
-- It does NOT encrypt; it only lets tests exercise the same SQL calls.
create schema if not exists vault;
create table if not exists vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text unique,
  description text not null default '',
  secret      text not null,
  updated_at  timestamptz not null default now()
);
create or replace view vault.decrypted_secrets as
  select id, name, description, secret as decrypted_secret, updated_at from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$
  insert into vault.secrets (name, description, secret) values (new_name, coalesce(new_description, ''), new_secret) returning id
$$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null)
returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), updated_at = now() where id = secret_id
$$;
grant usage on schema vault to service_role;
grant select, insert, update, delete on vault.secrets to service_role;
grant select on vault.decrypted_secrets to service_role;
grant execute on function vault.create_secret(text, text, text), vault.update_secret(uuid, text) to service_role;
