# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

Glio: Arabic-first AI ad operations for Saudi businesses and agencies. TypeScript monorepo (pnpm workspaces) on Supabase (Postgres + Auth + RLS). TikTok is the first and only channel until it passes real-data testing.

## Commands

```bash
pnpm install
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm test   # local throwaway Postgres only
pnpm typecheck
```

## Firm rules

1. **Tenancy.** Every table has `workspace_id` and RLS enabled with policies using `is_member` / `has_ws_role` / `can_see_client`. The tenancy test discovers tables automatically; a new table without correct RLS must fail it. Never weaken RLS.
2. **Numbers are never invented.** Every metric traces to a stored raw platform response. AI output is commentary only; every number it writes is validated against its input.
3. **No action without approval.** Platform writes go through `approval_requests` and one executor that enforces budget caps, saves before-state and supports undo.
4. **Credentials are server-only.** `ad_account_credentials` holds a reference, never a token. Never log tokens or send them to the AI.
5. **Audit log is append-only.** Never add a path that updates or deletes it.
6. **No image or video generation. Glio never holds ad money.**
7. **Arabic-first, KSA by design:** RTL, SAR in minor units, Asia/Riyadh, Hijri option.

## Workflow

- **Schema changes:** new timestamped file in `supabase/migrations/`; never edit an applied migration. Show the SQL and rationale to the owner before it is applied. Add the matching diagnostic query to `docs/RUNBOOK.md`.
- **Dependencies:** before adding one, state what it replaces and why.
- **Decisions:** add a short ADR to `docs/DECISIONS.md`. Keep `docs/COMPLIANCE.md` honest about what is and isn't built.
- **Tests alongside every change.** Seed data must be obviously synthetic ("Test Client A1", `@example.test`).
- **Platform APIs:** never invent endpoints; if a detail is unknown, stub it behind the connector interface with a clear TODO.
