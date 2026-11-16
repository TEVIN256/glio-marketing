-- =============================================================================
-- 0005  Report snapshots and AI commentary (M5)
--
--   ai_commentary     every generated summary, with the exact JSON input the
--                     model received (and its SHA-256), the prompt version and
--                     the prompt's SHA-256, the model used, whether the text
--                     came from the model or the deterministic template, and
--                     a log of EVERY attempt (including rejected ones and why).
--   report_snapshots  exactly what a client was shown or sent: the full report
--                     JSON (every figure with its value, display text and the
--                     raw platform payloads it came from), its SHA-256, and the
--                     commentary shown with it.
--
-- Both are permanent records: no updates, no direct deletes (only the client
-- cascade, e.g. a data deletion request). Signed-in users read by client
-- visibility; only the server writes.
-- =============================================================================

create table public.ai_commentary (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  client_id            uuid not null,
  input                jsonb not null,                -- exactly what the model received
  input_sha256         text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  prompt_version       text not null,
  system_prompt_sha256 text not null check (system_prompt_sha256 ~ '^[0-9a-f]{64}$'),
  model                text,                          -- null when no model was configured
  source               text not null check (source in ('llm', 'template')),
  text_ar              text not null,
  text_en              text not null,
  attempts             jsonb not null,                -- [{attempt, kind, ok, violations, error, output}]
  created_at           timestamptz not null default now(),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);
create index ai_commentary_client_idx on public.ai_commentary (workspace_id, client_id, created_at desc);

create table public.report_snapshots (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  client_id        uuid not null,
  date_from        date not null,
  date_to          date not null,
  report           jsonb not null,
  report_sha256    text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  commentary_id    uuid not null references public.ai_commentary (id),
  created_by       uuid references auth.users (id),
  created_by_label text,                              -- e.g. 'scheduler' when not a person
  created_at       timestamptz not null default now(),
  check (date_to >= date_from),
  check (created_by is not null or created_by_label is not null),
  foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade
);
create index report_snapshots_client_idx on public.report_snapshots (workspace_id, client_id, created_at desc);

-- Permanent records (guard function from migration 0004).
create trigger ai_commentary_no_update before update on public.ai_commentary
  for each row execute function public.block_mutation_except_cascade();
create trigger ai_commentary_no_direct_delete before delete on public.ai_commentary
  for each row execute function public.block_mutation_except_cascade();
create trigger ai_commentary_no_truncate before truncate on public.ai_commentary
  for each statement execute function public.block_mutation_except_cascade();
create trigger report_snapshots_no_update before update on public.report_snapshots
  for each row execute function public.block_mutation_except_cascade();
create trigger report_snapshots_no_direct_delete before delete on public.report_snapshots
  for each row execute function public.block_mutation_except_cascade();
create trigger report_snapshots_no_truncate before truncate on public.report_snapshots
  for each statement execute function public.block_mutation_except_cascade();

alter table public.ai_commentary    enable row level security;
alter table public.report_snapshots enable row level security;

create policy ai_commentary_select on public.ai_commentary for select to authenticated
  using (public.can_see_client(workspace_id, client_id));
create policy report_snapshots_select on public.report_snapshots for select to authenticated
  using (public.can_see_client(workspace_id, client_id));

revoke all on public.ai_commentary, public.report_snapshots from anon, authenticated;
grant select on public.ai_commentary, public.report_snapshots to authenticated;
grant select, insert, delete on public.ai_commentary, public.report_snapshots to service_role;
