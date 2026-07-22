# SOW Automation Tool — System Architecture

## What this is

An internal web app. Any employee signs in with their Google account, uploads a
Statement of Work (PDF or Word), and the tool automatically produces:

1. A fully-editable **Google Slides** client pitch deck (9 slides, content unique per SOW)
2. A **Google Sheets** project plan and tracker (2 tabs, fixed format, dropdowns, formulas)
3. A live **HTML dashboard** that reads that Sheet and shows KPIs, plus a button that
   exports a client-ready status report to Google Slides and pings the team on
   Google Chat and Gmail.

It is built in four phases so each piece is working and testable before the next
is added. This document describes the target end state; the current build covers
**all four phases** in full working code.

---

## Tech stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Frontend + backend | **Next.js 14** (App Router, TypeScript), deployed on **Vercel** | Same pattern as your Nisean project — one repo, `git push`, Vercel builds and hosts it. No servers to manage. |
| Sign-in | **NextAuth.js** with Google provider | Employees sign in with their real Google account. The same sign-in also grants (with consent) the permission the app needs to create files in *their* Drive — no shared "robot" account required, and every file is owned by a real person from day one. |
| Database | **Supabase** (hosted Postgres) | Stores job status, extracted SOW data, saved templates, and (Phase 2+) the team roster and stakeholder list. Free tier is enough to start. |
| File parsing | `pdf-parse` (PDF) and `mammoth` (.docx) | Extract raw text from the uploaded SOW before it goes to the AI. |
| AI extraction | **Anthropic Claude API** | Reads the raw SOW text and returns structured JSON (project name, client, deliverables, timeline, risks, etc.) that the rest of the pipeline uses to fill in the deck and sheet. |
| Slides/Sheets generation | **Google Slides API** + **Google Sheets API** + **Google Drive API** | Programmatically duplicates your template and fills in the placeholders, or builds the tracker sheet with formulas and dropdowns already in place. |
| Notifications | **Google Chat** (incoming webhook) + **Gmail API** | Phase 4: posts to a space and/or emails a client-ready summary (with the deck attached as PDF) when a status report is generated. |

Nothing here needs you to run a server, manage Docker, or touch a terminal after
the one-time setup. Day to day, employees only ever see the web page.

---

## How a single upload flows through the system (Phase 1)

1. Employee signs in with Google (OAuth) → grants the app permission to create
   files in their own Drive (Slides/Sheets/Drive scopes only — never full account
   access).
2. Employee goes to **Upload**, picks a SOW (PDF or .docx), optionally pastes a
   link to a custom Slides template, and clicks **Generate**.
3. The server extracts text and sends it to Claude, which does two different
   jobs in one pass: it **extracts** project name, client, overview, inputs
   needed, deliverables, milestones, and stakeholder names directly from the
   SOW; and it **analyzes** the project to generate the top 5 risks (ranked
   by likelihood × impact, with specific mitigations), a governance cadence,
   and an escalation matrix — using standard PM best practice, not just
   whatever text happens to appear in the SOW.
4. The server copies the chosen Slides template (or the org default) into the
   employee's Drive, then uses `replaceAllText` to swap every `{{TOKEN}}`
   placeholder in the template for the real content — this is what keeps the
   deck **fully editable**: it's a real Slides file, not a flattened export.
5. A job record in Supabase is updated at each step (`extracting` →
   `parsing` → `generating_slides` → `complete`), and the browser polls it so
   the employee sees live progress and, at the end, a link to open the deck.

Phases 2–4 hang off the same job record: Phase 2 adds Sheets generation and
Drive folder creation right after step 4; Phase 3 is a separate dashboard page
that reads any Sheet link a user pastes in; Phase 4 adds the "Generate Client
Status Report" button and the Chat notification.

---

## Security model

- **No shared credentials.** Every Slides/Sheets/Drive action runs using the
  signed-in employee's own OAuth token — the app never uses a shared "robot"
  account. It requests full Drive scope (`auth/drive`) rather than the more
  restrictive `drive.file`, because employees paste links to *existing*
  templates and folders they didn't create in the app (drive.file can only
  reach files the app itself created). In practice this means the app can do
  anything that specific employee could already do in their own Drive — the
  same access boundary as using Drive directly, not a widened one.
- **Org-restricted sign-in.** Once you move to the company Google Workspace,
  the OAuth consent screen is set to "Internal" — only accounts on your company
  domain can sign in at all.
- **Secrets never touch the browser.** The Anthropic API key and Supabase
  service key live only in Vercel's server-side environment variables.
- **Uploaded SOWs** are stored in Supabase Storage in a private bucket, not
  public; only the job owner and the server can read them.
- **The in-sheet "Generate Project Tracker" button** is a container-bound
  Apps Script the app installs on each spreadsheet via the Apps Script API.
  It only ever runs when a human opens that specific sheet and clicks the
  menu item, under *that person's* Google authorization (a separate,
  standard one-time Apps Script consent prompt) — it has no independent
  execution path and cannot act on any other file.
- **Business Unit Head sharing** is a single, explicit Drive `permissions.create`
  call (view access) made at generation time using the uploader's own
  identity — the same as that employee sharing the file by hand. No
  standing access is granted beyond that one file.
- **Gmail send scope (`gmail.send`, Phase 4)** only ever composes a brand-new
  message as the signed-in employee — it cannot read, list, or search
  anything already in that person's mailbox. A Chat webhook URL is itself
  the credential for that channel (anyone holding the link can post to that
  space), so it's stored per-project like a sheet link, not shared globally.

---

## Personal → company Google Workspace migration

You asked for a "single click" way to move from testing on your personal Gmail
to running under the company's Google Workspace. A literal single click isn't
possible — Google requires a distinct Cloud project and OAuth consent screen
per organization — but the app is built so the **only thing that changes is
environment variables**, not code:

1. Create a new Google Cloud project under the company Workspace (steps in the
   deployment guide).
2. Enable the same 4 APIs (Slides, Sheets, Drive, Chat) and configure the OAuth
   consent screen as "Internal."
3. In Vercel → Project → Settings → Environment Variables, replace
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with the new project's values.
4. Redeploy (Vercel does this automatically when you save env vars, or click
   "Redeploy").

No file in the codebase needs to change. That's as close to "one click" as
Google's setup allows, and it's documented step-by-step in the deployment guide.

---

## Phase breakdown

**Phase 1 — Upload → AI parsing → Slides deck ✅ built**
Sign-in, upload, Claude extraction, Slides generation from a token-based
template, job status polling.

**Phase 2 — Sheets tracker + Drive folders ✅ built**
The same upload now also generates the 2-tab Sheet (Estimation & Resource
Allocation, Project Tracking & Execution) right after the Slides deck. The
Estimation tab groups tasks into **deliverables** (a name in column A starts
a new deliverable; blank means "another task under the deliverable above"),
with a checkbox that copies Deliverable 1's full task list into any new
deliverable, and a live resource-allocation summary (to the right of the
task table) that updates itself the instant a name is added to the Lists
tab. An Apps Script the app installs on each spreadsheet adds a **Project
Tracker Tools ▸ Generate Project Tracker** menu that builds the Tracking tab
as a Deliverable × Task matrix — one row per deliverable, a repeating
6-column block per task (Assigned To, Hours, Baseline/Plan/Actual Date,
Status), plus a computed RAG status and Current Stage per deliverable that
also update live as dates/status change — while preserving anything already
entered for tasks that still exist. An optional **Business Unit Head** field
on the Upload form gets written into the sheet and the sheet is auto-shared
with that person. A separate `/drive-folders` page lets anyone paste a
parent folder link and a list of names to batch-create subfolders. See
`SHEETS_TRACKER.md` for the full layout.

**Phase 3 — HTML Dashboard ✅ built**
A `/dashboard` page where a user adds project sheets two ways: pasting a
tracker link directly, or typing a Business Unit Head's name/email to pull
in every completed job under them (found via the `bu_head_name`/
`bu_head_email` columns on `jobs`) — both are saved permanently to that
viewer's account in a new `dashboard_links` table, so the dashboard looks
the same every time they open it. The app reads each sheet live via the
Sheets API, using the *viewer's own* Google token — this only works for
sheets that person can already open (their own, auto-shared to them as BU
Head, or shared by hand), and a sheet that fails to read is reported
per-project instead of breaking the whole dashboard. Each project gets its
own tab plus an **All Projects** rollup tab. KPIs, computed from the live
Tracking sheet:
- **Overall RAG** — worst RAG across a project's deliverables.
- **Task Completion %** and **On-Time Completion %** (of completed tasks,
  how many finished on/before their Baseline Date).
- **Overdue Tasks** and **Blocked Tasks** — counts, drawn straight from the
  same logic the in-sheet Apps Script uses for RAG.
- **Upcoming Milestones** — tasks due in the next 7 days.
- **Days to Deadline** and **Schedule Pace** (Ahead / On Pace / Behind) —
  compares % of project time elapsed against % of tasks completed as a
  leading indicator, not just a lagging one.
- **Resource Allocation** — hours per person per project, and, on the All
  Projects tab, summed **across every project on the dashboard** — surfaces
  who's overloaded across a BU Head's whole portfolio, not just one project.
See `DASHBOARD.md` for the full explanation.

**Phase 4 — Client report export + Chat/Gmail notification ✅ built**
A **Generate Client Status Report** button on each project's dashboard tab
builds a brand-new, fully-editable Slides deck from scratch (no template) —
title slide, executive summary, deliverables table, upcoming & risks, and
resource allocation — straight from that project's live KPIs, the same ones
the dashboard shows. Two notification channels are optional, independent,
and best-effort on top of the deck (a failure in one never blocks the other
or the deck itself):
- **Google Chat** — a plain incoming webhook URL (Space → Apps &
  integrations → Webhooks in Google Chat), posted to with a summary and a
  link to the deck. Deliberately not the OAuth Chat API, which would require
  registering and publishing a full Chat app just to post a message.
- **Gmail** — sent as the signed-in employee's own Gmail (never a shared
  mailbox, and only ever composes a new message — nothing is read or
  searched), with the deck exported to PDF via Drive and attached, plus an
  HTML summary and a link to the live deck.
Whatever webhook URL and recipient list were used are saved back onto that
project's dashboard link, so the panel comes back pre-filled next time. See
`DASHBOARD.md` for the full explanation.

---

## What you'll need to provide at each phase

- **Now (Phase 1):** A Google Cloud project (personal Gmail is fine to start),
  an Anthropic API key, a Supabase account, a Vercel account.
- **Phase 2:** Nothing new — same accounts.
- **Phase 4:** The Gmail API enabled in the same Google Cloud project (see
  the deployment guide), and, only if you want the Chat notification, a
  webhook URL from a Google Chat space (Space → Apps & integrations →
  Webhooks) — no new account or paid tier needed for either.

Every account above is free to create and has a free tier sufficient for
testing.
