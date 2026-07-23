-- Run this once in Supabase → SQL Editor → New query, on a fresh project.
-- (Full instructions are in DEPLOYMENT_GUIDE.docx.)

create extension if not exists "pgcrypto";

-- One row per SOW upload / generation run.
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  status text not null default 'extracting'
    check (status in ('extracting', 'parsing', 'generating_slides', 'generating_sheet', 'finalizing', 'complete', 'error')),
  original_filename text not null,
  template_id text,
  sow_data jsonb,
  slides_url text,
  sheet_url text,
  sheet_id text,
  bu_head_name text,
  bu_head_email text,
  script_error text,
  error_message text,
  -- Comma-separated ISO 3166-1 alpha-2 codes (e.g. "IN,US,ZA") picked on the
  -- Upload form, used to build the holiday calendar the tracker's Baseline
  -- Date schedule (and Plan Date validation) skips. Null/empty = weekends
  -- only, no country holidays excluded.
  business_countries text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_user_email_idx on jobs (user_email);
create index if not exists jobs_created_at_idx on jobs (created_at desc);
create index if not exists jobs_bu_head_email_idx on jobs (bu_head_email);

-- Keeps updated_at current on every change.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_set_updated_at on jobs;
create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

-- Saved Slides templates, so the upload page can offer a dropdown instead of
-- requiring a pasted link every time. Populated starting Phase 1.5 / Phase 2.
create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slides_template_id text not null,
  created_by text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- Dashboard (Phase 3): the sheet links a person has added to their
-- dashboard — either pasted by hand, or auto-discovered by looking up a
-- Business Unit Head's completed jobs. One row per (viewer, sheet), so the
-- dashboard looks the same every time that person opens it.
create table if not exists dashboard_links (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  sheet_id text not null,
  sheet_url text not null,
  label text,
  source text not null default 'manual' check (source in ('manual', 'bu_head')),
  -- Phase 4: remembered so the "Generate Client Status Report" panel comes
  -- back pre-filled next time, instead of retyping every time.
  chat_webhook_url text,
  report_recipients text,
  created_at timestamptz not null default now(),
  unique (user_email, sheet_id)
);

create index if not exists dashboard_links_user_email_idx on dashboard_links (user_email);

-- Daily alerts: one encrypted Google refresh token per person, so the
-- unattended daily check (Vercel Cron, /api/cron/daily-alerts) can read
-- someone's tracker sheets and send email/Chat alerts without their
-- browser open. This is the ONLY server-stored long-lived Google
-- credential anywhere in this app — every other feature reads live using
-- the signed-in person's own session token, which never touches disk.
-- Populated automatically by lib/authOptions.ts on every sign-in
-- (encrypted with TOKEN_ENCRYPTION_KEY — see lib/tokenStore.ts); never
-- written to or read from the browser.
create table if not exists user_google_tokens (
  user_email text primary key,
  encrypted_refresh_token text not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists user_google_tokens_set_updated_at on user_google_tokens;
create trigger user_google_tokens_set_updated_at
  before update on user_google_tokens
  for each row execute function set_updated_at();

-- Row Level Security: the app's server code uses the Supabase *service role*
-- key, which always bypasses RLS — these policies only matter if you later
-- let the browser query Supabase directly with a user's own session.
alter table jobs enable row level security;
alter table templates enable row level security;
alter table dashboard_links enable row level security;

drop policy if exists "Users can read their own jobs" on jobs;
create policy "Users can read their own jobs"
  on jobs for select
  using (auth.jwt() ->> 'email' = user_email);

drop policy if exists "Anyone signed in can read templates" on templates;
create policy "Anyone signed in can read templates"
  on templates for select
  using (auth.role() = 'authenticated');

drop policy if exists "Users can manage their own dashboard links" on dashboard_links;
create policy "Users can manage their own dashboard links"
  on dashboard_links for select
  using (auth.jwt() ->> 'email' = user_email);

-- ── Storage bucket ──
-- Buckets can't be created from SQL. In the Supabase dashboard:
--   Storage → New bucket → name it exactly "sow-uploads" → set to PRIVATE.
-- This is where the original uploaded PDFs/DOCX files are kept for audit
-- purposes. The app only ever reads/writes it with the service role key.

-- ── Migrating an existing Phase 1 database to Phase 2 ──
-- Already ran this file once for Phase 1? Don't re-run the whole thing —
-- just run this block instead (safe to run more than once):
--
--   alter table jobs add column if not exists sheet_url text;
--   alter table jobs drop constraint if exists jobs_status_check;
--   alter table jobs add constraint jobs_status_check
--     check (status in ('extracting', 'parsing', 'generating_slides', 'generating_sheet', 'complete', 'error'));

-- ── Migrating an existing Phase 2 database to the WBS hierarchy + Apps
-- Script + Business Unit Head update ── run this block instead (safe to
-- run more than once):
--
--   alter table jobs add column if not exists sheet_id text;
--   alter table jobs add column if not exists bu_head_name text;
--   alter table jobs add column if not exists bu_head_email text;
--   alter table jobs add column if not exists script_error text;
--   alter table jobs drop constraint if exists jobs_status_check;
--   alter table jobs add constraint jobs_status_check
--     check (status in ('extracting', 'parsing', 'generating_slides', 'generating_sheet', 'finalizing', 'complete', 'error'));
--   create index if not exists jobs_bu_head_email_idx on jobs (bu_head_email);

-- ── Adding Phase 3 (Dashboard) to an existing database ── the
-- `create table if not exists dashboard_links` block above is already safe
-- to run on its own against an existing database — just run this whole
-- file again; every statement in it is idempotent (if not exists / or
-- replace / drop-then-create policy).

-- ── Adding Phase 4 (Client Status Report) to an existing database ──
-- Already have dashboard_links from Phase 3? Run this block (safe to run
-- more than once), or just re-run this whole file — everything in it is
-- idempotent:
--
--   alter table dashboard_links add column if not exists chat_webhook_url text;
--   alter table dashboard_links add column if not exists report_recipients text;

-- ── Adding business-day/holiday-aware scheduling to an existing database ──
-- Already have the jobs table from Phase 1? Run this block (safe to run
-- more than once), or just re-run this whole file:
--
--   alter table jobs add column if not exists business_countries text;
