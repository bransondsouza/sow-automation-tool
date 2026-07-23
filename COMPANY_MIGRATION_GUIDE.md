# Moving the SOW Automation Tool to the Company Setup

**Goal:** get the current working build running under company-owned accounts,
with company Google Workspace sign-in, so project managers can test it —
without touching a line of code.

Budget 60–90 minutes if you have admin rights to the accounts involved
yourself, or a bit longer if you need to loop in IT for the Google Workspace
step. This is infrastructure migration, not a rebuild: every account this app
currently runs on has a like-for-like company equivalent, and the code
doesn't change — only environment variables do.

---

## The short version

Five things currently live under your personal accounts. Each one gets a
company equivalent:

| Today (personal) | Becomes (company) | Why it matters |
|---|---|---|
| GitHub repo under your account | Repo under the company GitHub org | So the project isn't tied to one person's account long-term |
| Vercel project under your account | Vercel project under a company team | Same — ownership, billing, and access control move to the company |
| Google Cloud project + OAuth on your personal Gmail | Google Cloud project under the company Workspace org | **The big one** — this is what lets any `@yourcompany.com` account sign in, instead of a manually-added test-user list |
| Supabase project under your account | Supabase project under a company account | Stores job status and extracted SOW data |
| Anthropic API key under your account | Anthropic API key under a company-billed account | Powers the AI extraction step |

Nothing about how the app *works* changes. `ARCHITECTURE.md` already calls
this out as a deliberate design choice — the only thing that should ever need
to change for a new environment is which set of API keys Vercel is holding.

---

## Before you start

Have these ready, or know who to ask:

- **A company Google Workspace admin**, or admin rights yourself. You need
  the ability to create a Google Cloud project under the company's
  Workspace org and set the OAuth consent screen to **Internal**. This is
  the one step that can't be done from a personal account — it has to be
  created by someone whose Google account belongs to the company org.
- **A company GitHub organization** (or a plan to create one — free).
- **A company Vercel team** (or Vercel account you're comfortable owning
  this under — Vercel's free/Hobby tier is enough for PM testing).
- **A way to pay for Anthropic API usage under the company** (a company
  card or existing vendor account). Cost is small — a typical SOW costs a
  fraction of a cent to a few cents to parse — but it shouldn't sit on a
  personal card once PMs start using it regularly.
- **A Supabase account** for the company (free tier is enough for testing).
- 3–5 project managers' company email addresses, to test with.

---

## Step 1 — Move the code to a company GitHub repo

1. Create a new **private** repository under the company's GitHub
   organization, e.g. `sow-automation-tool`.
2. Easiest path — add the company repo as a second remote and push your
   existing history to it, so nothing is lost:
   ```bash
   cd sow-automation-tool
   git remote add company https://github.com/YOUR-COMPANY-ORG/sow-automation-tool.git
   git push company main
   ```
   If you'd rather start clean without your personal commit history, you can
   instead just add all files to a fresh repo — either works, since Vercel
   only needs the current code, not the history.
3. From here on, treat the company repo as the source of truth. You can keep
   your personal repo around as a backup, or archive it once the company one
   is confirmed working.

If you're using GitHub Desktop rather than the terminal: **Repository** menu
→ **Repository Settings** → change the remote URL to the company repo, or
simply clone the new empty company repo and copy your project files into it,
then commit and push through the normal GitHub Desktop flow.

---

## Step 2 — Google Cloud project under the company Workspace

This is the step that actually gets you something better than what you have
today, not just a copy of it. Because the company is on Google Workspace,
you get **Internal** OAuth — sign-in restricted automatically to
`@yourcompany.com` accounts, with no 100-person test-user cap and no Google
verification review to wait on. This is only possible from a Workspace org
account, which is why an admin (or admin rights) is needed for this step.

1. Sign in to [console.cloud.google.com](https://console.cloud.google.com)
   with a Google account that belongs to the company Workspace.
2. Top-left dropdown → **New Project**. Name it "SOW Automation Tool"
   → **Create**. Make sure it's selected.
3. **APIs & Services** → **Library**. Search for and **Enable**, one at a
   time:
   - Google Slides API
   - Google Sheets API
   - Google Drive API
   - Google Apps Script API
   - Gmail API

   > **No Google Chat API needed.** The Chat notification in the dashboard
   > uses a plain incoming webhook per Chat space, not the OAuth Chat API —
   > nothing to enable here for it.

4. **APIs & Services** → **OAuth consent screen**.
   - User type: **Internal** (this option only appears because the project
     belongs to a Workspace org — this is the payoff for this whole step).
   - Fill in the app name, your email as support and developer contact.
   - Because it's Internal, there's no "Testing" mode, no test-user list, and
     no publishing/verification step — every company account can sign in
     immediately once the OAuth client exists.
5. **APIs & Services** → **Credentials** → **+ Create Credentials** →
   **OAuth client ID**.
   - Application type: **Web application**, name it "SOW Tool Web".
   - **Authorized redirect URIs** — add a placeholder for now, you'll fix it
     in Step 6:
     - `https://YOUR-COMPANY-VERCEL-URL.vercel.app/api/auth/callback/google`
   - **Create**, then copy the **Client ID** and **Client Secret** somewhere
     safe.

> **One per-person setting to flag to PMs before they test.** Anyone who
> will click the in-sheet **Generate Project Tracker** button needs their
> own "Google Apps Script API" personal setting turned on at
> [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
> — it's off by default and there's no way for the app to turn it on for
> someone else. If it's off, everything else still works; only that one
> in-sheet menu is skipped, and the status page says so. Worth a one-line
> mention in whatever message you send PMs to kick off testing.

---

## Step 3 — Company Anthropic API key

This is what reads each SOW and extracts the structured project data (see
"About the AI provider" below if you're weighing whether to keep this or
move to your internal LLM / Gemini instead).

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up
   using a company email, or have whoever manages vendor accounts do this.
2. Add a company payment method under **Billing**.
3. **API Keys** → **Create Key**. Copy it somewhere safe (a password
   manager, not a chat message) — you can't view it again after this.

---

## Step 4 — Company Supabase project

1. [supabase.com](https://supabase.com) → sign up/sign in with a company
   email → **New project**. Name it, set a database password, pick a region
   → **Create**.
2. **SQL Editor** → **New query**. Open `supabase/schema.sql` from the repo,
   copy the whole file, paste it in, **Run**. This creates every table the
   app needs in one go — you don't need to run the smaller migration blocks
   further down that file; those are only for updating an *existing*
   database, and this one is brand new.
3. **Storage** → **New bucket** → name it exactly `sow-uploads`, set
   **Private** → **Create**.
4. **Project Settings** → **API** → copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role secret** → `SUPABASE_SERVICE_ROLE_KEY`

You're starting with an empty database — none of your personal testing data
carries over. For a PM-testing rollout that's the right call: PMs should be
generating their own sample uploads, not looking at your test data.

---

## Step 5 — Rebuild or copy the Slides template

Your existing default pitch-deck template lives in your personal Google
Drive, which the company OAuth app can't reach (it's a different Drive
identity entirely). Two options:

- **Copy it in:** open your existing template, **File → Make a copy**, then
  move that copy into a company-owned Drive location (a shared drive, or a
  folder owned by whoever's account will be the long-term owner). Grab its
  file ID from the URL.
- **Rebuild it:** follow `TEMPLATE_TOKENS.md` in the repo from scratch —
  10–15 minutes.

Either way, that file ID is your new `DEFAULT_TEMPLATE_ID`.

---

## Step 6 — Deploy to a company Vercel project

1. [vercel.com](https://vercel.com) → sign in with the company GitHub
   account/org → **Add New** → **Project** → import the company repo from
   Step 1.
2. Framework auto-detects as **Next.js** — leave build settings default.
3. Before deploying, add every environment variable:

   | Key | Value |
   |---|---|
   | `NEXTAUTH_SECRET` | Generate at generate-secret.vercel.app/32 |
   | `NEXTAUTH_URL` | Leave blank — set after first deploy gives you a URL |
   | `GOOGLE_CLIENT_ID` | From Step 2 |
   | `GOOGLE_CLIENT_SECRET` | From Step 2 |
   | `ANTHROPIC_API_KEY` | From Step 3 |
   | `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` (or leave blank) |
   | `SUPABASE_URL` | From Step 4 |
   | `SUPABASE_SERVICE_ROLE_KEY` | From Step 4 |
   | `SUPABASE_STORAGE_BUCKET` | `sow-uploads` |
   | `DEFAULT_TEMPLATE_ID` | From Step 5 |

4. **Deploy**. Once it finishes, copy the live URL (something like
   `sow-automation-tool-yourcompany.vercel.app`).
5. Go back and fix the two things that needed the real URL:
   - Vercel → Settings → Environment Variables → set `NEXTAUTH_URL` to your
     real URL → **Save** → **Deployments** → **Redeploy**.
   - Google Cloud Console → Credentials → your OAuth client → replace the
     placeholder redirect URI with the real one:
     `https://YOUR-REAL-URL.vercel.app/api/auth/callback/google`

---

## Step 7 — Verify it yourself before handing it to PMs

Sign in with your own company Google account and run through one full
upload end to end before anyone else touches it:

1. Open the live URL, **Sign in with Google** using your company account.
   Because the consent screen is Internal, this should just work — no test
   user list to check.
2. Grant the requested permissions (Slides/Sheets/Drive/Gmail access — this
   is expected).
3. **Upload**, pick a sample SOW, leave the template field blank (uses your
   `DEFAULT_TEMPLATE_ID`), click **Generate Pitch Deck + Tracker**.
4. Confirm both the Slides deck and the Sheets tracker open correctly, and
   that the **Project Tracker Tools ▸ Generate Project Tracker** menu
   appears in the sheet (accept the separate Apps Script authorization
   popup the first time — that's normal, not an app bug).
5. Open **/dashboard**, paste the tracker link in, confirm the KPIs and
   charts load, and try the **Generate Client Status Report** button.

If anything fails, the status page shows a plain-English error — see the
troubleshooting list at the bottom of `DEPLOYMENT_GUIDE.md`, which still
applies here unchanged.

---

## Step 8 — Hand it to project managers

Because sign-in is Internal/Workspace-restricted, there's no test-user list
to maintain — send the URL to any company Google accounts you want testing
it and they can sign in immediately. A short message to PMs should cover:

1. The live URL and "sign in with your company Google account."
2. What to test: uploading a real or sample SOW, checking the generated deck
   and tracker sheet for accuracy, trying the dashboard on a tracker sheet
   with some data in it, and (if relevant to their role) the status report
   export.
3. The one-time personal setting from Step 2 (Apps Script API), only
   relevant if they'll click the in-sheet tracker-generation menu.
4. Where to send feedback/bugs — a shared doc, a Slack/Chat channel, or
   directly back to you.
5. That this is a **testing build** — enhancements are still in progress, so
   some rough edges are expected and exactly what you're looking for
   feedback on.

---

## About the AI provider — Claude, your internal LLM, and Gemini

The extraction step (turning raw SOW text into structured project data) is
isolated in one file, `lib/claude.ts`, and currently calls the Anthropic
Claude API. A few things worth knowing as you weigh this against your
internal LLM or Gemini:

- **You don't need to change this to move to company setup.** A
  company-billed Anthropic key (Step 3) is all that's needed — the rest of
  this guide works exactly as written either way.
- **Swapping providers is possible without touching anything else in the
  app** — the extraction call has one job (send SOW text in, get structured
  JSON back), so pointing it at Gemini or an internal LLM endpoint instead
  is a contained change to that one file, not a rebuild. It's a reasonable
  next enhancement once PM feedback on the current build comes in, rather
  than something to bundle into this migration.
- **Worth knowing before that swap:** the app currently relies on Claude's
  structured-output reliability (consistently valid JSON matching an exact
  schema) — whichever model replaces it needs the same guarantee, or the
  extraction step needs added validation/retry logic to match. Not a
  blocker, just something to scope properly rather than swap casually.
- **Google Suite is already doing a lot of work here** — Slides, Sheets,
  Drive, Gmail, and now Internal sign-in are all Workspace APIs the app is
  built directly on top of, so being a Google Workspace company is a
  genuine advantage for this specific tool, independent of which AI model
  does the extraction.
- **NotebookLM** isn't part of this app's pipeline and there's no natural
  plug-in point for it in the current architecture — it's built for
  interactive research/Q&A over a document set, not for producing
  structured output on a schedule. If there's a specific workflow in mind
  for it (e.g., PMs cross-checking a generated deck against the source SOW),
  that'd be a separate, manual complement to this tool rather than something
  to wire in.

---

## Keeping both environments running

Nothing about this migration is destructive. Your personal setup keeps
working exactly as it does today — Vercel, Supabase, and Google Cloud
projects are fully independent of each other. Keep it running as your own
sandbox for as long as it's useful, and treat the company one as the version
that matters going forward.

---

## Quick reference — what changes vs. what doesn't

**Changes:** GitHub remote, Vercel project, Google Cloud project + OAuth
client, Supabase project, Anthropic key, Slides template file ID — i.e.
every environment variable in Step 6.

**Doesn't change:** every line of application code, `supabase/schema.sql`,
`TEMPLATE_TOKENS.md`, and every other doc in this repo. Once the new
environment variables are in place in Vercel, the company deployment behaves
identically to your personal one.
