# Backlog

Builds agreed or proposed but not started. Newest decisions first within each section.
When an item is built, move its outcome to `DECISIONS.md` (ADR) and `RUNBOOK.md`, and delete it here.

## Next

### Live "today so far" and hourly view (requested 2026-11-26)

Show the current day while it is still running, per client.

- **"Today so far" panel** at the top of the client page: spend, purchase value, ROAS, conversions, clicks,
  with "Updated HH:MM (Riyadh)" and a refresh button.
- **Hourly chart for today**, with yesterday's hours as a faint comparison line.
- **Open question for the owner:** account totals only, or also per campaign for today.
- **Provisional, always labelled:** "Today's figures are provisional; TikTok may still revise them."
  - Purchases keep being attributed for days after a click, so today's value and ROAS will still change.
  - TikTok's own reporting runs a little behind.
- **Kept out of** reports, emails, share links and the reconciliation badge. Completed days still come only from
  the normal daily sync.
- **How it refreshes:** fetched when the page is opened or refreshed, at most every ~10 minutes per client.
  - The page refreshes itself while open.
  - The Vercel Hobby plan allows one scheduled job a day, so there is no background polling.
  - This also keeps TikTok requests low.
- **TikTok side:** the report with the `stat_time_hour` dimension covers one day per request, in the ad account's
  time zone.
- **Rules that still apply:** every fetch is archived in `raw_platform_payloads` like any other response, so today's
  numbers stay traceable (firm rule 2).
- **Needs:** one small migration for provisional "today" rows, separate from `metric_daily`.

### Break-even ROAS on the dashboard

- Show a break-even line or marker on the ROAS tile and in the campaign table.
- Break-even ROAS = 1 ÷ gross margin.
- **Needs from the owner:** each client's approximate gross margin (a client setting, owners and managers edit).

## Later

- **Report and figure views in the audit log.** Only client dashboards write `client.viewed` today (COMPLIANCE.md:
  "Partial").
- **Disconnect TikTok from inside GLIO**, including token revocation at TikTok (`/oauth2/revoke_token/`).
  - Deleting a client removes GLIO's data and the Vault token.
  - TikTok-side revocation is still manual.
- **Workspace and user-account deletion.** Currently on request by email (COMPLIANCE.md).
- **Other purchase values:**
  - in-app: `total_purchase_value`
  - TikTok Shop: `total_onsite_shopping_value`
  - Only website purchases are fetched now (ADR-031).
- **TikTok Reporting API v2.0.** v1.3 has no announced end date. When it gets one, move the report calls behind the
  same connector interface (ADR-028).
- **More channels:** Snapchat, Meta, Google Ads. The connector interface is ready; each needs its own platform app
  review.
