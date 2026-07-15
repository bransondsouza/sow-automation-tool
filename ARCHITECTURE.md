# SOW Automation Tool — System Architecture

## What this is

An internal web app. Any employee signs in with their Google account, uploads a
Statement of Work (PDF or Word), and the tool automatically produces:

1. A fully-editable **Google Slides** client pitch deck (9 slides, content unique per SOW)
2. A **Google Sheets** project plan and tracker (2 tabs, fixed format, dropdowns, formulas)
3. A live **HTML dashboard** that reads that Sheet and shows KPIs, plus a button that
   exports a client-ready status report to Google Slides and pings the team on
   Google Chat.

It is built in four phases so each piece is working and testable before the next
is added. This document describes the target end state; the current build covers
**Phase 1** in full working code, with Phases 2–4 scoped and ready to build next.

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
| Notifications | **Google Chat API** (webhook or app) | Phase 4: posts to a space when a client report is generated. |

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
Allocation, Project Tracking & Execution) right after the Slides deck, with
the required columns and editable dropdown lists (statuses, stakeholder
roster). Tasks on the Estimation tab use a WBS numbering scheme (`1`, `1.1`,
`1.2.1`...) so a project can be freely restructured into sub-projects and
steps of any depth — e.g. one SOW milestone becomes "Lesson 1" with its own
steps underneath. An Apps Script the app installs on each spreadsheet adds a
**Project Tracker Tools ▸ Generate Project Tracker** menu that (re)builds the
Tracking tab from whatever's on the Estimation tab at that moment — any
number of tasks, any nesting, in any order — while preserving Actual dates /
Owner / Status already entered for tasks that still exist. An optional
**Business Unit Head** field on the Upload form gets written into the sheet
and the sheet is auto-shared with that person. A separate `/drive-folders`
page lets anyone paste a parent folder link and a list of names to
batch-create subfolders. See `SHEETS_TRACKER.md` for the full layout.

**Phase 3 — HTML Dashboard**
A page where a user can add one or more tracker Sheet links; the app reads
each live via the Sheets API and renders it as its own tab, with the 7 KPI
widgets (Schedule Variance, Resource Utilization, Task Completion %,
High-Risk Triggers, Delays, On-Time %, plus one more we'll finalize) —
letting one person (e.g. a Business Unit Head) flip between several
projects' health in one page. A combined "All Projects" tab rolls the same
KPIs up across every added project. Because the BU Head field from Phase 2
is stored in our database, the dashboard can also auto-populate: type a BU
Head's name/email and it pulls in every tracker generated under them,
instead of pasting each link by hand. This depends on those sheets already
being shared with whoever's viewing the dashboard (handled automatically by
the Phase 2 auto-share, for the BU Head specifically).

**Phase 4 — Client report export + Chat notification**
"Generate Client Status Report" button compiles the live KPIs into a new
Slides deck, and posts a message to the project's Google Chat space (pulled
from the roster set up in Phase 2) confirming it's ready.

---

## What you'll need to provide at each phase

- **Now (Phase 1):** A Google Cloud project (personal Gmail is fine to start),
  an Anthropic API key, a Supabase account, a Vercel account.
- **Phase 2:** Nothing new — same accounts.
- **Phase 4:** A Google Chat space per project (or one shared space to start)
  and its webhook URL, or Chat app credentials if you want richer bot messages.

Every account above is free to create and has a free tier sufficient for
testing.
