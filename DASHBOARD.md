# How the Project Dashboard works

`/dashboard` is a live view over any number of Project Plan & Tracker sheets
— your own, or anyone's you have access to. It doesn't store your project
data; every time you open it, it re-reads the live sheets with your own
Google account. This document explains how projects get onto your
dashboard, what each KPI means, and how it's computed.

## Getting projects onto your dashboard

There are two ways, and you can mix both:

1. **Paste a sheet link.** Under "Add a project by sheet link," paste the
   Project Plan & Tracker link (an optional label helps if the sheet's own
   title is generic). It's saved to your account immediately.
2. **Pull by Business Unit Head.** Type a name or email under "Pull all
   projects under a Business Unit Head" and click Pull. This searches every
   completed upload for a matching `Business Unit Head` field (set on the
   Upload form) and adds every sheet it finds — saved to your account the
   same as a pasted link, so you only need to do this once per person.

Either way, what you add is **remembered** — it's stored in your account
(a `dashboard_links` table, keyed to your email), not just for the current
browser session. Use **Remove from dashboard** (on a project's tab, or next
to an error in the warning box) to take one off — this only removes it from
your dashboard, it never touches the actual Google Sheet.

**The setup panel gets out of the way once you have data.** The first time
the dashboard loads with at least one project on it, the "Add a project" /
"Pull by Business Unit Head" panel collapses automatically — you land
straight on the tabs and widgets from then on. Click **+ Manage Projects**
(top right) any time you want to add another link, pull a different BU
Head, or hit Refresh.

**A sheet only shows up if you can already open it.** The dashboard reads
every sheet using *your own* Google sign-in — the same as opening it in
Drive yourself. If you're the Business Unit Head named on a project, it was
auto-shared with you when the project was generated (Phase 2). Otherwise,
ask whoever generated the sheet to share it with your email first — if you
add or pull in a sheet you don't have access to, it shows up as an error
under the project list instead of breaking the rest of your dashboard.

## Layout

- One **tab per project**, named after the project.
- An **All Projects** tab that rolls the same numbers up across everything
  on your dashboard — this is the view a Business Unit Head managing
  several projects will likely live in day to day.

If a project's Project Tracking & Execution tab hasn't been generated yet
(the Estimation tab is still being filled in), its tab shows a short notice
instead of KPIs — nothing to compute yet.

## KPI definitions

All of these are computed from the live Tracking sheet — the same
Deliverable × Task matrix, RAG values, and Current Stage the in-sheet Apps
Script maintains (see `SHEETS_TRACKER.md`). The dashboard doesn't
recalculate RAG itself; it reads what's already in the sheet, so it's
always consistent with what you see when the sheet is open.

**Per project:**

| KPI | What it means |
|---|---|
| Overall Health (RAG) | The worst RAG across all of a project's deliverables: any Red deliverable makes the whole project Red; else any Amber makes it Amber; else Gray if nothing's finished; Green only if every deliverable is Green. |
| Task Completion % | Completed tasks ÷ total tasks, across every deliverable. |
| On-Time Completion % | Of the tasks that are Completed, the % whose Actual Date was on or before their Baseline Date. Blank if nothing's completed yet. |
| Overdue Tasks | Tasks not yet Completed whose Baseline Date has passed. |
| Blocked Tasks | Tasks whose Status starts with "Blocked." |
| Upcoming Milestones | Tasks not yet Completed with a Baseline Date in the next 7 days — a "what's due soon" list. |
| Days to Deadline | Project End Date minus today. |
| Schedule Pace | Compares % of the project's calendar time elapsed against % of tasks completed. More than 15 points behind → **Behind**; more than 15 points ahead → **Ahead**; otherwise **On Pace**. This is a leading indicator — it can flag a problem before any single task is technically "overdue." |
| Resource Allocation | Hours Allocated summed per person, from every task they're Assigned To on that project. |

**All Projects (rollup):**

| KPI | What it means |
|---|---|
| Active Projects | Count of projects on your dashboard. |
| Avg. Task Completion | Average of each project's Task Completion %. |
| Overdue / Blocked Tasks | Summed across every project. |
| Upcoming Milestones | Summed across every project, next 7 days. |
| RAG Breakdown | How many projects are currently Red / Amber / Gray / Green. |
| Resource Load Across Projects | The same per-person hour totals as above, but **added up across every project on the dashboard** — this is the one number a single-project view can't give you: who's carrying the most hours once you account for everything they're on. |

## Charts and widgets

Every KPI above also has a visual next to it — hover any chart for exact
values (Chart.js's built-in tooltips):

- **Deliverable Health** (donut) — deliverables by RAG.
- **Task Status Breakdown** (bar) — how many tasks currently sit in each
  Status value from the Lists tab (Completed, WIP, Blocked, On Hold, YTS,
  or any custom status you've added).
- **Burndown — Ideal Pace vs Actual** (line) — a dashed "ideal pace" line
  (linear from Project Start to Project End) against a solid "actual" line
  built from tasks' real Actual Dates. When the actual line sits below the
  ideal line, the project is behind; above it, ahead. Only shown once both
  project dates are set.
- **Resource Allocation** (bar) — same hours-per-person data as the table
  below it, as a quick visual scan.
- **Deliverable Timeline** — a dependency-free Gantt-style strip: one bar
  per deliverable spanning its earliest to latest task Baseline Date,
  colored by RAG, against the Project Start → Project End axis, with a red
  marker for today. Hover a bar for its exact date range.
- **Portfolio RAG** and **Resource Load Across Projects** (All Projects
  tab) — the same idea, aggregated across your whole dashboard.

## Delivery Calendar

Below the Deliverable Timeline on every tab (per-project, and All Projects
with a Project column added) is an interactive calendar:

- Each date shows a count badge for how many tasks have a **Baseline Date**
  that day, colored red if any of that day's tasks are overdue or Blocked,
  green if every task that day is Completed, amber if anything's in
  progress, or navy if nothing's started yet.
- **Click a date** with a badge to list exactly what's due that day —
  deliverable, task, who it's assigned to, and status — right below the
  calendar. Click it again (or another date) to change the selection.
- Use **← / → / Today** to move between months.
- **From / To** date filters and the **Stage / Task Type** dropdown (built
  from that project's actual task names) narrow everything on the
  calendar — the day badges, the click-through list, and the three mini
  KPIs below the filters:
  - **Delay %** — the share of *currently filtered* tasks that are overdue.
    (The main KPI grid's "Overdue Tasks" count is always for the whole
    project; this one moves with your filters.)
  - **Busiest Day** — the single date with the most deliveries in the
    filtered range.
  - **In Range** — total task deliveries matching the current filters.

Example: to see how loaded up August is, set From = Aug 1, To = Aug 31 and
leave Stage on "All stages" — the calendar, Delay %, and Busiest Day all
narrow to just that window.

## What's next (Phase 4)

A "Generate Client Status Report" button that compiles a project's current
KPIs into a new Slides deck and posts a notification to Google Chat.
