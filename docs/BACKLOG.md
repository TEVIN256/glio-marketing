# Backlog

Builds agreed or proposed but not started. Newest decisions first within each section.
When an item is built, move its outcome to `DECISIONS.md` (ADR) and `RUNBOOK.md`, and delete it here.

## Next

### Zid: first real connection (built 2026-11-27, ADR-039)

- Owner: create the Private app in Zid's Partner Dashboard, add `ZID_CLIENT_ID` / `ZID_CLIENT_SECRET` in Vercel, connect WAKE UP's store (RUNBOOK "Zid store connection").
- Then compare GLIO's daily orders and gross with Zid's dashboard for a few days (time zone of day boundaries, partial refunds).
- Later: Salla with the same design; per-channel attribution needs UTM data Zid's order list doesn't carry.

## Later

- **TikTok Reporting API v2.0.** v1.3 has no announced end date. When it gets one, move the report calls behind the
  same connector interface (ADR-028).
- **More channels:** Snapchat, Meta, Google Ads. The connector interface is ready; each needs its own platform app
  review.
