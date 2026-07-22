# Deployment Guide — SOW Automation Tool (Phases 1–4)

Written for someone doing this without a coding background. Every step is a
click-by-click instruction. Budget about 60–90 minutes for the first setup.

A note on format: this is a Markdown file rather than a Word document — build
a real .docx wasn't possible in this session (no code-execution environment
was available to generate one). You can open this file in any text editor,
or paste it into Google Docs / Word if you'd like a formatted copy — headings
and lists will carry over cleanly.

**Already deployed Phase 1 and just pulled the Phase 2 update?** You don't
need to redo any account setup — Slides, Sheets, and Drive APIs were already
enabled in step 1. Just do two things: (1) run the small migration block at
the bottom of `supabase/schema.sql` in the Supabase SQL Editor, and (2)
`git push` the updated code so Vercel redeploys it. Everything else in this
guide (steps 1–6) only applies to a brand-new setup.

**Already deployed the earlier version of Phase 2 and just pulled the WBS
hierarchy / Apps Script / Business Unit Head update?** Do three things:
(1) run the *second* migration block at the bottom of `supabase/schema.sql`,
(2) in Google Cloud Console, enable the **Apps Script API** (step 1 below now
lists 5 APIs instead of 4 — just enable the one you're missing), (3)
`git push` and redeploy. Then read the callout in step 1 about each
employee's personal Apps Script API setting — it's new and easy to miss.

**Already deployed and just pulled the Phase 4 (Client Status Report)
update?** Do three things: (1) run the "Adding Phase 4" migration block at
the bottom of `supabase/schema.sql`, (2) in Google Cloud Console, enable the
**Gmail API** (step 1 below now lists 5 required APIs — Google Chat API is
no longer one of them; see the callout there), (3) `git push` and redeploy.
Anyone already signed in needs to sign out and back in **once** to grant the
new Gmail permission — until they do, the email step of a status report
fails with a message telling them so (the Slides deck and Chat notification
still work either way).

**Already deployed and just pulled the business-day scheduling update
(holiday-aware Baseline Date + Plan Date warnings)?** Just two things: (1)
run the "Adding business-day/holiday-aware scheduling" migration block at
the bottom of `supabase/schema.sql`, (2) `git push` and redeploy — Vercel
installs the new `date-holidays` npm dependency automatically as part of
`npm install`. Nothing to do in Google Cloud: no new API, no new OAuth
scope, no account to sign up for — the holiday data ships inside the npm
package itself. This only affects **new** uploads going forward; sheets
generated before this update keep their original weekends-only schedule.

---

## What you'll create, in order

1. A Google Cloud project + OAuth credentials (on your personal Gmail, for testing)
2. An Anthropic API key
3. A Supabase project (the database)
4. A default Google Slides template
5. A GitHub repository with this code
6. A Vercel deployment
7. Your first test upload

---

## 1. Google Cloud project + OAuth credentials

This lets employees "Sign in with Google" and lets the app create Slides
files on their behalf.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   sign in with the Google account you're testing with (your personal Gmail
   is fine to start).
2. Top-left dropdown → **New Project**. Name it "SOW Automation Tool" → **Create**.
3. Make sure the new project is selected (top-left dropdown).
4. Left sidebar → **APIs & Services** → **Library**. Search for and **Enable**,
   one at a time:
   - Google Slides API
   - Google Sheets API
   - Google Drive API
   - Google Apps Script API *(powers the in-sheet "Generate Project Tracker" button)*
   - Gmail API *(powers the "Generate Client Status Report" email — Phase 4)*

   > **You do NOT need to enable a Google Chat API.** The Phase 4 "ping the
   > team on Google Chat" step uses a plain incoming webhook URL, which you
   > set up per Chat space (not per Google Cloud project) — see `DASHBOARD.md`.
   > There's no separate setup step for it here.

   > **Important — a setting Google hides per-person, not per-project.**
   > Enabling the Apps Script API above is only half of what's needed. Every
   > individual employee who will *generate* a tracker (i.e., use the Upload
   > page) also needs their own "Google Apps Script API" personal access
   > turned on, at
   > [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
   > — it's **off by default** on most accounts and there's no way for the
   > app to turn it on for someone else. If it's off, the pitch deck and
   > tracker sheet still generate fine; only the in-sheet button gets
   > skipped (the status page will say so). Worth doing this once, now, on
   > your test account, and mentioning it when you roll this out company-wide.
5. Left sidebar → **APIs & Services** → **OAuth consent screen**.
   - User type: **External** (until you move to a Workspace domain, "Internal"
     isn't available — External is correct for personal Gmail testing).
   - Fill in the app name ("SOW Automation Tool"), your email as support
     contact, and your email again as developer contact. Save and continue
     through the remaining screens (Scopes, Test users).
   - On the **Test users** screen, add every Gmail address that should be
     able to sign in during testing (Google limits External apps in "Testing"
     mode to a max of 100 explicitly-added testers).
6. Left sidebar → **APIs & Services** → **Credentials** → **+ Create
   Credentials** → **OAuth client ID**.
   - Application type: **Web application**.
   - Name: "SOW Tool Web".
   - **Authorized redirect URIs** — add both of these (you'll get the real
     Vercel URL in step 6; add a placeholder now and come back to fix it):
     - `http://localhost:3000/api/auth/callback/google`
     - `https://YOUR-VERCEL-URL.vercel.app/api/auth/callback/google`
   - Click **Create**. Copy the **Client ID** and **Client Secret** somewhere
     safe — you'll paste them into Vercel shortly.

---

## 2. Anthropic API key

This is what reads each SOW and extracts the structured project data.

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up
   or sign in.
2. Add a payment method under **Billing** (usage is pay-as-you-go; parsing a
   typical SOW costs a fraction of a cent to a few cents).
3. Left sidebar → **API Keys** → **Create Key**. Copy it somewhere safe — you
   won't be able to view it again.

---

## 3. Supabase project (the database)

This stores the status of every upload and the extracted project data.

1. Go to [supabase.com](https://supabase.com) → sign up / sign in → **New
   project**.
2. Name it "sow-tool", set a database password (save it somewhere), pick a
   region close to your team → **Create new project** (takes ~2 minutes).
3. Once it's ready, left sidebar → **SQL Editor** → **New query**. Open the
   file `supabase/schema.sql` from this project folder, copy its entire
   contents, paste into the editor, and click **Run**. You should see
   "Success. No rows returned."
4. Left sidebar → **Storage** → **New bucket**. Name it exactly `sow-uploads`,
   and set it to **Private**. Click **Create bucket**.
5. Left sidebar → **Project Settings** → **API**. Copy two values you'll need
   for Vercel:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role secret** (under "Project API keys" — click to reveal) →
     this is `SUPABASE_SERVICE_ROLE_KEY`

   The service_role key bypasses all access rules — never put it in
   client-side code or share it outside Vercel's environment variables. This
   app only ever uses it on the server, which is why it's safe here.

---

## 4. Build the default Slides template

Follow **`TEMPLATE_TOKENS.md`** in this project folder — it walks through
designing your 9-slide deck in Google Slides with the correct placeholder
tokens, and getting its file ID. Takes 10–15 minutes. Keep that ID handy;
it's the `DEFAULT_TEMPLATE_ID` value.

---

## 5. Push the code to GitHub

Vercel deploys straight from a GitHub repository, the same way your Nisean
project was set up.

1. Go to [github.com/new](https://github.com/new), create a new **private**
   repository (e.g. `sow-automation-tool`). Don't initialize it with a
   README (you already have one).
2. On your computer, open a terminal in the `sow-tool` folder and run:
   ```bash
   git init
   git add .
   git commit -m "Phase 1: upload, AI parsing, Slides generation"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/sow-automation-tool.git
   git push -u origin main
   ```
   If you don't have Git installed or aren't comfortable with the terminal,
   GitHub Desktop (desktop.github.com) does the same thing with buttons
   instead of commands: **Add local repository** → pick the `sow-tool`
   folder → **Publish repository**.

---

## 6. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → sign in (ideally with the same
   GitHub account) → **Add New** → **Project**.
2. Import the `sow-automation-tool` repository you just pushed.
3. Framework preset should auto-detect as **Next.js** — leave build settings
   as default.
4. Before clicking Deploy, open **Environment Variables** and add every
   value from `.env.example`:

   | Key | Value |
   |---|---|
   | `NEXTAUTH_SECRET` | Generate one at generate-secret.vercel.app/32 |
   | `NEXTAUTH_URL` | Leave blank for now — you'll set this after the first deploy gives you a URL |
   | `GOOGLE_CLIENT_ID` | From step 1 |
   | `GOOGLE_CLIENT_SECRET` | From step 1 |
   | `ANTHROPIC_API_KEY` | From step 2 |
   | `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` (or leave blank for the same default) |
   | `SUPABASE_URL` | From step 3 |
   | `SUPABASE_SERVICE_ROLE_KEY` | From step 3 |
   | `SUPABASE_STORAGE_BUCKET` | `sow-uploads` |
   | `DEFAULT_TEMPLATE_ID` | From step 4 |

5. Click **Deploy**. Wait for the build to finish, then copy the live URL
   Vercel gives you (something like `sow-automation-tool.vercel.app`).
6. Go back and fill in the two things that needed the real URL:
   - **Vercel** → Project → Settings → Environment Variables → set
     `NEXTAUTH_URL` to `https://sow-automation-tool.vercel.app` (your actual
     URL) → **Save**, then **Deployments** tab → **Redeploy** the latest one.
   - **Google Cloud Console** → Credentials → your OAuth client → edit the
     redirect URI placeholder from step 1 to your real URL:
     `https://sow-automation-tool.vercel.app/api/auth/callback/google`

---

## 7. Test it

1. Open your live Vercel URL. Click **Sign in with Google**, use one of the
   test-user Gmail accounts you added in step 1.
2. Grant the permissions it asks for (Slides, Sheets, Drive access — this is
   expected; it's what lets the app create files on your behalf). Because
   Phase 2 upgraded the Drive permission the app asks for, sign out and back
   in once if you signed in before this upgrade — the app forces a fresh
   consent screen every sign-in, so this happens automatically.
3. Go to **Upload**, choose a sample SOW (PDF or .docx), leave the template
   field blank to use your default template, optionally type a few names
   into **Team roster**, and optionally a name + email into **Business Unit
   Head**, then click **Generate Pitch Deck + Tracker**.
4. Watch the progress steps. When it finishes, you'll see two buttons:
   **Open Pitch Deck** (a real, editable Slides deck with the SOW's content
   filled into the 9 slides) and **Open Project Tracker** (a Google Sheet
   with the Estimation and Tracking tabs — see `SHEETS_TRACKER.md` for what
   to expect).
5. Open the tracker sheet and look for a **Project Tracker Tools** menu next
   to Help in the menu bar. Click it → **Generate Project Tracker**. The
   *first* time you do this, Google will show its own "Authorization
   required" popup (separate from signing into the app) — click **Review
   permissions**, pick your account, click **Allow**. This is normal for any
   Apps Script the first time it runs. After that, running it again just
   works.
6. If you entered a Business Unit Head email, check that inbox — they should
   have received Google's automatic "shared with you" notification for the
   tracker sheet.
7. Try the folder tool too: go to **Create Drive folders** (top of the
   Upload page), paste a link to any folder you own, list a few names, and
   confirm the subfolders appear.

If something fails, the status page shows a plain-English error message.
Common causes:

- **"No Slides template is configured"** — `DEFAULT_TEMPLATE_ID` is missing
  or wrong in Vercel's environment variables.
- **"insufficient permission" from Google** — the signed-in account hasn't
  granted the Slides/Sheets/Drive/Apps Script scopes yet, or isn't in the
  OAuth test users list. Sign out and sign back in to re-trigger consent.
- **The tracker generated but the "Generate Project Tracker" menu never
  appears in the sheet** — this is the non-fatal Apps Script warning shown
  on the status page. Almost always means either the Apps Script API isn't
  enabled in Google Cloud, or that specific employee hasn't turned on their
  personal Apps Script API access (see the callout in step 1).
- **"Couldn't access that parent folder"** (Drive folders tool) — the link
  is wrong, or the signed-in account doesn't have access to that folder.
- **Claude/JSON parsing errors** — usually a very unusual SOW format; try a
  cleaner PDF/Word export.

---

## 8. Later: moving to the company Google Workspace

When you're ready to roll this out beyond testing:

1. Repeat step 1 above, but signed in as an admin on the **company**
   Workspace, and set the OAuth consent screen's User type to **Internal**
   (only shows up when your Cloud project belongs to a Workspace org) — this
   restricts sign-in to company accounts automatically, no test-user list
   needed.
2. In Vercel → Project → Settings → Environment Variables, replace
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with the new project's
   values. Everything else (Supabase, Anthropic, the template) can stay
   exactly as-is, or you can duplicate those too if you want a fully separate
   company environment.
3. Redeploy. No code changes required — this is the "single environment
   swap" migration path described in `ARCHITECTURE.md`.

---

## What's next

This covers Phase 1. When you're ready, say so and we'll build Phase 2 (the
Sheets tracker + Drive folder creation) on top of this same project.
