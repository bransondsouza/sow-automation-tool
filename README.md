# SOW Automation Tool — Phase 1 + Phase 2

Turns an uploaded Statement of Work (PDF or Word) into a fully-editable
Google Slides client pitch deck **and** a Google Sheets project plan &
tracker, automatically. Also includes a standalone Drive folder-creation
tool.

This covers **Phase 1 and Phase 2** of a 4-phase build. See `ARCHITECTURE.md`
for the full system design and what Phases 3–4 (HTML dashboard, client
report + Chat notifications) will add.

## New to this project? Start here

Open **DEPLOYMENT_GUIDE.md** — it's a click-by-click walkthrough written
for someone with no coding experience, covering:

1. Creating the Google Cloud project and OAuth credentials
2. Getting an Anthropic (Claude) API key
3. Creating the Supabase database
4. Building the default Slides template (`TEMPLATE_TOKENS.md`)
5. Deploying to Vercel
6. Testing your first upload
7. Moving from your personal Google account to the company Workspace later

Already deployed Phase 1? The guide has a short "upgrading from Phase 1"
note near the top — you only need to run a small database migration and
redeploy, not redo the whole setup.

## Project structure

```
app/                     Pages and API routes (Next.js App Router)
  page.tsx                 Landing / sign-in page
  upload/page.tsx           Upload form (SOW + template + roster + BU Head)
  status/[jobId]/page.tsx   Live job progress + links to both outputs
  drive-folders/page.tsx    Standalone Drive folder creation tool
  api/upload/route.ts       Handles the upload → parse → Slides → Sheet → share pipeline
  api/status/[jobId]/route.ts  Job status polling endpoint
  api/drive-folders/route.ts   Creates subfolders in an existing Drive folder
  api/auth/[...nextauth]/route.ts  Google sign-in
lib/                      Server-side logic
  authOptions.ts            NextAuth + Google OAuth config
  claude.ts                 SOW → structured JSON via Claude (extract + PM analysis)
  parseDocument.ts          PDF/DOCX text extraction
  googleSlides.ts            Template copy + token replacement
  googleSheets.ts             Tracker generator (WBS-based Estimation tab, empty Tracking tab)
  googleAppsScript.ts          Installs the in-sheet "Generate Project Tracker" button
  googleDrive.ts               Folder creation + file-sharing helpers
  supabase.ts                 Database client
  types.ts                    Shared TypeScript types
supabase/schema.sql        Database schema — run once in Supabase (includes
                            migration blocks for upgrading from earlier phases)
TEMPLATE_TOKENS.md         How to build the default Slides template
SHEETS_TRACKER.md          How the generated tracker sheet & its button work
ARCHITECTURE.md            Full system design, all phases
```

## Local development (optional)

You don't need to do this to deploy — Vercel builds it for you. Only useful
if someone technical wants to test changes locally first.

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000.
