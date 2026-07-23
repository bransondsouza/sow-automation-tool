# Session Handoff — SOW Automation Tool

Paste or attach this file at the start of a new conversation to pick up
exactly where this one left off, focused on **moving the app to company
accounts so PMs can test it**. Everything below is current as of this
session; the docs it points to live in this same repo and are the source of
truth for anything not summarized here.

---

## What this is, in one paragraph

An internal Next.js web app (Vercel-hosted, Supabase-backed) where an
employee signs in with Google, uploads a Statement of Work (PDF/.docx), and
the app uses Claude to extract structured project data, then generates a
fully-editable Google Slides pitch deck and a Google Sheets project
tracker (with an in-sheet Apps Script for RAG status, business-day/
holiday-aware scheduling, and live resource allocation). A separate
`/dashboard` page reads any tracker sheet live and shows KPIs, interactive
charts (click a chart/card to filter the task list and see the KPIs
recompute), a delivery calendar, and a button to export a client-ready
status report to Slides with optional Google Chat/Gmail notification.

## Current status

**All four build phases are complete and working**, plus several rounds of
enhancements on top (dashboard click-to-filter interactivity, a redesigned
visual Slides status-report deck, business-day/holiday-aware scheduling).
This is a **workable version** — functional end to end — with more
enhancements expected later. Nothing described below is broken or
half-built; it's tested and confirmed working by the project owner.

Everything currently runs under **personal accounts**: personal GitHub (via
GitHub Desktop), personal Vercel project, personal Supabase project, a
Google Cloud project tied to a personal Gmail (OAuth consent screen in
**External/Testing** mode — capped at 100 manually-added test users), and a
personal Anthropic API key.

## The active task: company migration

**Goal:** move the five account dependencies above to company-owned
equivalents so any company Google account can sign in and project managers
can test the live app — with **zero code changes**.

**The plan is fully written out in `COMPANY_MIGRATION_GUIDE.md`** (same repo
root). Don't re-derive this — read that file for the actual steps. Summary
of its 8 steps:

1. Push the repo to a company GitHub org.
2. Create a Google Cloud project under the **company Google Workspace org**
   and set the OAuth consent screen to **Internal** — this is the step that
   actually improves on the current setup (no test-user cap, no
   verification wait, auto-restricted to the company domain). Requires a
   Workspace admin account for this one step only.
3. Get a company-billed Anthropic API key.
4. Create a company Supabase project, run `supabase/schema.sql` once
   (fresh install — don't run the smaller incremental migration blocks
   further down that file, those are only for updating an existing DB).
5. Copy or rebuild the default Slides pitch-deck template into a
   company-owned Drive location, grab its file ID.
6. Deploy to a company Vercel project with the new environment variables
   (full table is in the migration guide).
7. Sign in yourself with a company account and run one full upload →
   deck → tracker → dashboard cycle before anyone else touches it.
8. Send PMs the URL and a short testing brief — sign-in is Internal, so
   there's no test-user list to manage; any company account can sign in
   immediately.

### Not yet done / decisions still open

These weren't resolved in the prior session — the new conversation should
either confirm these or treat them as the first things to sort out:

- **Who has Google Workspace admin rights** to create the company Cloud
  project and flip OAuth to Internal? This is the one hard blocker — every
  other step can be done from a regular account.
- **Does the company already have a GitHub org, Vercel team, and Supabase
  account**, or do these need to be created from scratch?
- **Who owns billing** for the company Anthropic key and Supabase project
  long-term (not meant to stay on anyone's personal card)?
- **AI provider decision** — keep Anthropic Claude (zero extra work, just
  needs a company key) vs. investigate swapping to the company's internal
  LLM or Google Gemini. The migration guide's "About the AI provider"
  section has the reasoning: it's a contained follow-up change (isolated in
  `lib/claude.ts`), not something that needs to happen for PMs to start
  testing. Revisit after PM feedback, not before.
- **Which PMs** specifically will test first, and what feedback channel
  (shared doc, Chat/Slack channel, direct messages) they should use.

## Where things live

- Repo root: `sow-tool/sow-automation-tool` (this is also the git root,
  tracked via GitHub Desktop today).
- **`COMPANY_MIGRATION_GUIDE.md`** — the step-by-step migration plan (read
  this first in the new session).
- `ARCHITECTURE.md` — full system design, tech stack, phase-by-phase
  breakdown, security model.
- `DEPLOYMENT_GUIDE.md` — the original personal-account setup instructions
  (still accurate; the migration guide builds directly on this pattern).
- `DASHBOARD.md` — dashboard KPIs, charts, click-to-filter behavior,
  delivery calendar.
- `SHEETS_TRACKER.md` — tracker sheet layout, RAG logic, business-day
  scheduling.
- `TEMPLATE_TOKENS.md` — how to build/rebuild the Slides template.
- `.env.example` and `supabase/schema.sql` — exact env var list and full
  DB schema, both current.

## A few technical facts worth knowing before touching code again

- The AI extraction call is isolated in `lib/claude.ts` — safe to swap
  providers there without touching the rest of the pipeline, but whatever
  replaces Claude needs equally reliable structured JSON output, or the
  extraction step needs added validation/retry logic.
- `date-holidays` (npm) powers business-day/holiday scheduling entirely
  server-side — no external API call, no new account needed even if this
  moves to a new environment.
- Google Slides API custom object IDs must be **≥5 characters** — this
  caused a real production bug once (short prefixes like `tb`/`tbl`); the
  ID generator now guards against it.
- Chart.js tooltip callbacks need to be typed against
  `TooltipItem<keyof ChartTypeRegistry>` (the real Chart.js type), not a
  hand-rolled narrower shape — a build broke on this once.
- Global `button` CSS in `globals.css` sets `display:inline-flex`,
  `color:#fff`, and `margin-top:24px` — any new clickable KPI-card-style
  button needs to explicitly reset those three or it renders with invisible
  white text in a squished layout (this exact bug happened once and was
  fixed for `.kpi-card-clickable`).
- Known risky pattern to avoid: `let x: SomeUnionType | null = null`
  reassigned inside a `.forEach` closure — has caused type-narrowing issues
  before. Prefer `Array.from(map.entries()).reduce(...)` instead.

## Suggested opening message for the new session

> "Continuing the SOW Automation Tool company migration — see
> SESSION_HANDOFF.md and COMPANY_MIGRATION_GUIDE.md for context. [Then say
> what's actually ready: e.g. 'I have Workspace admin access, let's start
> Step 2' or 'I need help figuring out who has GitHub org access first.']"
