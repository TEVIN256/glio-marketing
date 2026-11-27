-- =============================================================================
-- 0021  Snapchat (reporting): the account picker also serves Snapchat
--
--   pending_ad_connections.platform may be 'snapchat' as well as 'tiktok'
--   (several ad accounts authorised at once: the owner chooses, ADR-032).
--   ad_accounts, metric_daily and the sync tables already allow 'snapchat'
--   (migration 0001/0003). Snapchat tokens: Vault only, as for TikTok; GLIO
--   keeps Snap's refresh token and mints 1-hour access tokens per sync (ADR-041).
-- =============================================================================

alter table public.pending_ad_connections drop constraint pending_ad_connections_platform_check;
alter table public.pending_ad_connections add constraint pending_ad_connections_platform_check
  check (platform in ('tiktok', 'snapchat'));
