# How the generated Project Plan & Tracker works

Every upload creates one new Google Sheet with three tabs, plus a small
script attached to the file that adds a menu button. This document explains
the layout, the hierarchy model, and exactly what that button does.

## Tab 1: Estimation & Resource Allocation

- **Row 1** — `Project Start Date` (cell B1), `Project End Date` (cell D1),
  and `Business Unit Head` (cell F1, pre-filled if you entered one on the
  Upload page). Project Start Date is what everything else calculates from.
- **Row 4** — column headers; rows below are frozen-scroll so headers stay
  visible. Columns:
  - **WBS #** — a Work Breakdown Structure number: `1`, `2`, `3`... for
    top-level items, `1.1`, `1.2` for things nested under item 1, `1.2.1`
    for something nested under 1.2, and so on to any depth. This is how you
    model "Lesson 1 has steps A, B, C" or "Sub-project 2 has its own
    sub-project 2.1" — there's no separate hierarchy feature to learn, just
    a numbering convention. **Type these as plain numbers with dots** — the
    sheet is pre-formatted so `1.10` won't accidentally turn into `1.1`.
  - **Task / Sub-Project / Step Name** — whatever that WBS item is.
  - **Estimated Days Required** — fill this in on the *lowest-level* items
    (the actual steps) that consume time. Parent/summary rows (anything with
    children beneath it, like "Lesson 1") don't need their own estimate —
    their dates get rolled up automatically from their children.
  - **Estimated Effort (Hours)** and **Team Members Assigned** — same idea:
    fill in per leaf task, comma-separated names for the team column.
  - **Effort per Member (Hrs)** — a live formula: Estimated Effort ÷ number
    of names in Team Members Assigned. Feeds the resource summary below.
  - **Notes** — free text; pre-filled with SOW timing context where available.
- **On generation**, this tab starts with one flat top-level row per
  milestone the AI found in the SOW (WBS `1`, `2`, `3`...) plus 5 blank
  buffer rows. The SOW doesn't know about your internal sub-project
  structure, so **restructuring into a real hierarchy is a manual step**:
  renumber/insert rows so related steps share a parent WBS prefix (e.g. turn
  flat items 3, 4, 5 into `2` "Lesson 2", `2.1`, `2.2`, `2.3`). Insert rows
  as needed — WBS numbers just need to sort sensibly, they don't need to be
  contiguous.
- **Resource Allocation Summary** (a few rows below the task table) — one
  row per team member (seeded from the roster you typed in on the Upload
  page, editable), each with a live formula summing that person's
  "Effort per Member" across every task they're listed on.

## Tab 2: Project Tracking & Execution

This tab starts **empty** (just a header and an instructional note) — it's
populated entirely by the button described below, not by formulas, because
with unlimited nesting and rows you can freely insert/reorder/delete, a
fixed formula-per-row-number approach breaks. Values instead of formulas
also means edits here (Actual dates, Owner, Status) are simple typing, not
fighting a formula.

### The "Generate Project Tracker" button

Open the sheet and look for **Project Tracker Tools** in the menu bar (next
to Help). Click it → **Generate Project Tracker**. What it does:

1. Reads every row on the Estimation tab that has both a WBS # and a Name
   (blank buffer rows are skipped).
2. Sorts them in proper WBS order (`1`, `1.2`, `1.10`, `2` — not
   alphabetically, which would put `1.10` before `1.2`).
3. Figures out which rows are "parents" (anything with a WBS # that other
   rows are nested under).
4. Calculates **Planned Start/End Date** for every leaf task by cascading
   sequentially from the Project Start Date + each task's Estimated Days,
   in WBS order. Parent rows get their date range **rolled up** from their
   own children (earliest start, latest end) — so "Lesson 1" automatically
   shows the span covering all of its steps.
5. Writes one row per WBS item to this tab, indenting the name slightly per
   nesting level so the hierarchy is visually readable.
6. **Preserves your work**: if a WBS # already has a row on this tab with
   Actual Start/End Date, Owner, or Status filled in, those values carry
   over to the regenerated row — regenerating never throws away progress
   you've logged, as long as the WBS # didn't change.
7. Re-applies the Status dropdown, Stakeholder/Owner dropdown, and the
   gray/yellow/green Status color-coding to exactly the new set of rows.

Run it again any time you restructure or add tasks on the Estimation tab —
that's the whole workflow: edit Sheet 1, click the button, Sheet 2 updates.

**First-time authorization:** the very first time anyone clicks this button,
Google shows its own "Authorization required" popup — separate from signing
into the web app. Click **Review permissions** → pick the account → **Allow**.
This is standard for any Google Apps Script and only happens once per person
per sheet.

**If the menu doesn't appear at all:** the app couldn't install the script
automatically for this sheet (shown as a warning on the upload status page).
This is almost always either the Apps Script API not being enabled in Google
Cloud, or that employee's personal Apps Script API access being off — see
`DEPLOYMENT_GUIDE.md`.

## Tab 3: Lists (hidden)

Unhide it any time via *View → Show hidden sheets* in Google Sheets:

- **Column A** — Status options. Add a row (`On Hold`, `Blocked`, etc.) and
  it's immediately selectable in the Status dropdown, up to row 31.
- **Column B** — the team roster. Add or remove names and the Stakeholder /
  Owner dropdown updates immediately, up to row 31.

No code, no re-running anything — just edit the cells.

## Business Unit Head sharing

If you entered a Business Unit Head name + email on the Upload page, the
generated sheet is automatically shared with that email (view access) the
moment it's created — they'll get Google's normal "shared with you"
notification and can open it with their own Google login. The same email is
what the Phase 3 dashboard will use to automatically find every project
under a given BU Head.

## What's next (Phase 3)

The dashboard will read this exact tab/column layout live, and will use the
Business Unit Head field to auto-discover every tracker that head owns.
