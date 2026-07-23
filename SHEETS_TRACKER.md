# How the generated Project Plan & Tracker works

Every upload creates one new Google Sheet with four tabs, plus a small
script attached to the file that adds a menu button and a few automations.
This document explains the deliverable/task model, the layout, and exactly
what the button and its automations do.

## The mental model: Deliverables and Tasks

A project has one or more **deliverables** (e.g. "Lesson 1", "Module A",
"Client Report v1" — whatever your projects call their outputs). Each
deliverable is made up of the same kind of **tasks** (e.g. "Script Writing,"
"Review," "QA"). Sheet 1 is where you define this; Sheet 2 turns it into a
live tracking grid — one row per deliverable, one column-block per task.

## Tab 1: Estimation & Resource Allocation

- **Row 1** — `Project Start Date` (cell B1), `Project End Date` (cell D1),
  `Business Unit Head` (cell F1), and three **Projected** financial fields:
  `Projected Revenue ($)` (H1), `Projected Subcon Cost ($)` (J1), and
  `Projected Resources (#)` (L1) — set once, at project start. Project Start
  Date is what every deliverable's schedule cascades from. Click into either
  date cell and Sheets pops up a calendar picker.
- **Row 2** — an instructional note (A2) plus three **Actual** financial
  fields in the same column positions as their Projected counterparts:
  `Actual Revenue ($)` (H2), `Actual Subcon Cost ($)` (J2), and `Actual
  Resources (#)` (L2). Update these whenever the real numbers change — no
  fixed cadence required; a Monday-morning automation (see "Financial
  History," below) snapshots whatever's here into a dated row every week
  regardless of whether it changed, so the dashboard always has a full
  trend even in a flat week.
- **Row 4** — column headers; rows below are frozen-scroll. Columns:
  - **Deliverable Name** — type a name here to start a new deliverable.
    **Leave it blank** on the rows below to mean "another task under the
    same deliverable" — you don't repeat the name on every row.
  - **Task Name** — one row per task.
  - **Estimated Days Required** / **Estimated Effort (Hours)** — fill in
    per task; these drive the schedule and the resource summary.
  - **Team Members Assigned** — comma-separated names for that task.
  - **Effort per Member (Hrs)** — live formula, Estimated Effort ÷ number of
    names in Team Members Assigned.
  - **Notes** — free text.
  - **Copy Tasks from Deliverable 1** — a checkbox (see below).
  - **Dependency** — a dropdown, `Non-dependent` (default) or `Dependent`,
    meaning "this task depends on the one immediately before it." This is
    what the dashboard's simplified Critical Path groups tasks by — see
    `DASHBOARD.md`.

### Adding a second (third, fourth...) deliverable

**Deliverable 1** is the template — fill it in completely: its name, and
every one of its task rows with estimated days/effort/team.

For every deliverable after that, you only need to type its name in a new
row's **Deliverable Name** cell, then **tick the checkbox in column H** on
that same row. The moment you check it:

- All of Deliverable 1's tasks (names, estimated days, effort, team members,
  Dependency) get copied in as new rows under your new deliverable.
- The checkbox resets itself to unchecked.
- You can now edit any of the copied values if this deliverable's resourcing
  is different — the copy is a starting point, not a link.

The checkbox is pre-installed all the way down column H, so it's always
ready the instant you type a new deliverable name — nothing needs to run
first.

### Resource Allocation Summary (columns J-K)

This sits to the **right** of the task table (not below it) so it doesn't
get pushed further down as you add more deliverables. It lists every name
on the Lists tab's roster and totals their allocated hours across every
task, on every deliverable, they're assigned to.

**It updates itself automatically.** Add a name to the Lists tab's roster
column and it appears here immediately — no regenerating, no re-running
anything. This is a live spreadsheet formula (`FILTER`), not something the
button builds.

## Tab 2: Project Tracking & Execution

This tab starts **empty** — it's built entirely by the button below, as a
matrix:

| Deliverable Name | *(7 spare columns)* | RAG | Current Stage | Task 1 block (7 cols) | Task 2 block (7 cols) | ... | Quality % |
|---|---|---|---|---|---|---|---|

Each task's block has: **Assigned To** (dropdown, pre-filled from that
task's Team Members on Sheet 1), **Hours Allocated** (optional, feeds a
future resource-utilization chart — fine to leave blank), **Baseline Date**,
**Plan Date**, **Actual Date** (all three with the calendar picker),
**Status** (dropdown), and **Dependency** (dropdown, re-synced fresh from
the Estimation tab every time you regenerate — unlike Plan/Actual/Status,
it's planning data, not something the tracker preserves across a
regenerate). The trailing **Quality %** column is one per deliverable
(0–100), entered directly here by the PM — nothing calculates it.

### The "Generate Project Tracker" button

Open the sheet and look for **Project Tracker Tools** in the menu bar (next
to Help) → **Generate Project Tracker**. What it does:

1. Reads every deliverable and its tasks from the Estimation tab.
2. Uses **Deliverable 1's task list, in order, as the column template** —
   every deliverable's tasks line up against those same column positions.
   (A deliverable with extra tasks beyond Deliverable 1's list gets extra
   columns added; this is why sticking to the copy-checkbox workflow keeps
   everything tidiest.)
3. Calculates **Baseline Date** for every task by cascading sequentially
   from the Project Start Date + that task's own Estimated Days, task by
   task, within each deliverable — **skipping weekends automatically**, and
   skipping the public holidays of whichever countries you picked on the
   Upload form's "Exclude holidays of these countries" field (see below).
4. Computes **RAG** and **Current Stage** for each deliverable (see below).
5. **Preserves your work**: Assigned To, Hours Allocated, Plan Date, Actual
   Date, Status, and Quality % are kept for any (deliverable, task name) or
   (deliverable) pair that still exists — regenerating never throws away
   progress you've logged. **Dependency is the one exception** — it's always
   re-copied fresh from the Estimation tab, the same treatment as Baseline
   Date, since it's planning data rather than execution progress.
6. Colors the Status cells and the RAG cell automatically.
7. The first time it's ever run on a sheet, installs a weekly (Monday,
   6am) time-based trigger that snapshots the Estimation tab's Actual
   Revenue/Subcon Cost/Resources into the Financial History tab — see
   below. Re-running the button never creates a duplicate trigger.

Run it again any time you add deliverables or tasks on the Estimation tab.

**First-time authorization:** the first time anyone clicks this button (or
triggers any of the automations below), Google shows its own "Authorization
required" popup — separate from signing into the web app. Click **Review
permissions** → pick the account → **Allow**. Standard for any Apps Script,
only happens once per person per sheet.

**If the menu doesn't appear at all:** the app couldn't install the script
automatically (shown as a warning on the upload status page) — almost
always the Apps Script API not being enabled in Google Cloud, or that
employee's personal Apps Script API access being off. See
`DEPLOYMENT_GUIDE.md`.

### RAG logic (Red / Amber / Green / Gray)

Computed per deliverable, from all of its tasks:

- 🔴 **Red** — any task is overdue against its Baseline Date and not marked
  Completed, or any task's Status starts with "Blocked."
- 🟡 **Amber** — nothing overdue, but at least one task has drifted (its
  Plan or Actual date is later than its Baseline Date) or is in progress.
- 🟢 **Green** — every task is Completed.
- ⚪ **Gray** — nothing has started yet.

This isn't only computed at generate time — **editing any task's Baseline,
Plan, Actual, or Status cell recomputes that row's RAG and Current Stage
immediately**, live, without needing to click the button again.

### Current Stage

Reports the first task (in column order) that isn't yet Completed, as
`"<Task Name> · <Status>"` — e.g. `"QA Review · WIP"`. Shows `"Done"` once
every task is Completed.

### A couple of built-in conveniences

- **Auto Actual Date**: change any task's Status to something starting with
  "Completed" and, if its Actual Date is still blank, today's date is
  filled in automatically.
- **Calendar picker**: click into any Baseline/Plan/Actual/Project date
  cell and Sheets shows a date picker — no need to type dates by hand.

### Business-day scheduling (weekends + holidays)

**Baseline Date** is fully automatic and always business-day-aware: it
never lands on a weekend, and it never lands on a public holiday for any
country you selected on the Upload form's "Exclude holidays of these
countries" field when this project was uploaded. If you didn't pick any
countries, it still skips weekends — country holidays are the opt-in part,
weekends are always excluded.

**Plan Date stays exactly what it's always been: a manual field you fill in
yourself** — the tracker doesn't calculate it or overwrite it. The one thing
that's new is a check: type (or paste) a Plan Date that lands on a weekend
or one of those countries' public holidays, and Sheets pops up a prompt —
*"Plan Date falls on a weekend"* or *"...a public holiday (India: Diwali)"*
— asking whether to keep it anyway. Choose **Yes** to keep the date as
typed, or **No** to clear the cell and pick a different date. **Baseline**
and **Actual** dates are never checked this way — Baseline can't be wrong by
construction, and Actual records what really happened, holiday or not.

The holiday calendar itself is computed once, at upload time, from the
countries you picked — see `ARCHITECTURE.md` for why it's a snapshot rather
than a live lookup, and note that this only applies to **new** uploads;
sheets generated before this feature keeps their original weekends-only
schedule unless you regenerate the project.

## Tab 3: Lists (hidden)

Unhide it any time via *View → Show hidden sheets*:

- **Column A** — Status options (`YTS`, `WIP`, `Completed`, `Blocked`,
  `On Hold` by default). Add a row and it's immediately selectable in every
  Status dropdown on the Tracking tab — no regenerating needed.
- **Column B** — the team roster. Add or remove names and both the
  Assigned To dropdowns *and* the Resource Allocation Summary on Sheet 1
  update immediately.

## Tab 4: Financial History

A plain append-only log: `Date`, `Actual Revenue ($)`, `Actual Subcon Cost
($)`, `Actual Resources (#)` — one new row every Monday at 6am, written by
the weekly trigger described above. It exists so the dashboard can show a
trend over time, not just the single current Projected-vs-Actual snapshot
on the Estimation tab. Nothing here is meant to be edited by hand; if you
need to correct a historical figure, do it going forward — the log is a
record of what the Estimation tab said each week, not a source you write
back into.

**Trackers generated before this feature shipped** don't have this tab, and
the dashboard handles that gracefully — it just shows no financial trend
for that project rather than erroring. There's currently no way to add this
tab to an already-generated sheet short of creating a new project.

## Business Unit Head sharing

If you entered a Business Unit Head name + email on the Upload page, the
generated sheet is automatically shared with that email (view access) the
moment it's created.

## What's next (Phase 3)

The dashboard will read this exact Deliverable × Task matrix live, using RAG
and Current Stage for at-a-glance health, and Hours Allocated + Assigned To
for the resource-utilization chart.
