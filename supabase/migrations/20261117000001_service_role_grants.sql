-- =============================================================================
-- 0002  Explicit grants for the server role (service_role)
--
-- Supabase can be set to NOT grant table privileges automatically
-- ("Automatically expose new tables" off, the recommended setting). Glio's
-- server code uses service_role to write credentials, approvals and audit
-- entries, so it must not depend on automatic grants. service_role bypasses
-- RLS by design; these grants only give it table access.
--
-- Safe to run more than once.
-- =============================================================================

grant select, insert, update, delete on public.workspaces             to service_role;
grant select, insert, update, delete on public.clients                to service_role;
grant select, insert, update, delete on public.memberships            to service_role;
grant select, insert, update, delete on public.ad_accounts            to service_role;
grant select, insert, update, delete on public.ad_account_credentials to service_role;
grant select, insert, update         on public.approval_requests      to service_role;
-- audit_log: the server may read and append; update/delete are blocked by
-- trigger anyway, and are not granted.
grant select, insert                 on public.audit_log              to service_role;
grant usage, select on all sequences in schema public to service_role;
