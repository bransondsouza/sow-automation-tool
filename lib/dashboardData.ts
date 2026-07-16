import { google } from "googleapis";
import { extractSheetId } from "./googleSheets";

// Mirrors the column layout the Apps Script writes (see
// lib/googleAppsScript.ts) — kept as plain constants here rather than
// imported, since the script's copy runs inside Google's sandbox, not this
// codebase.
const EST_SHEET_NAME = "Estimation & Resource Allocation";
const TRACK_SHEET_NAME = "Project Tracking & Execution";
const TRACK_LEADING_COLS = 10; // A Deliverable, B-H spare (7), I RAG, J Current Stage
const TRACK_COLS_PER_TASK = 6; // Assigned To, Hours, Baseline, Plan, Actual, Status

const UPCOMING_WINDOW_DAYS = 7;
const SCHEDULE_DRIFT_THRESHOLD = 15; // percentage points between % time elapsed and % tasks complete

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

// ─────────────────────────────── Shapes ───────────────────────────────

export interface TaskSnapshot {
  slotLabel: string;
  assignedTo: string;
  hours: number | null;
  baseline: string;
  plan: string;
  actual: string;
  status: string;
  completed: boolean;
  blocked: boolean;
  overdue: boolean;
  onTime: boolean | null; // null when not yet completed
  upcoming: boolean;
}

export interface DeliverableSnapshot {
  name: string;
  rag: string;
  currentStage: string;
  tasks: TaskSnapshot[];
}

export type OverallRag = "Red" | "Amber" | "Gray" | "Green" | "Not Started";
export type SchedulePace = "Ahead" | "On Pace" | "Behind" | "Unknown";

export interface ProjectKpis {
  overallRag: OverallRag;
  totalTasks: number;
  completedTasks: number;
  taskCompletionPct: number;
  onTimeCompletionPct: number | null;
  overdueTaskCount: number;
  blockedTaskCount: number;
  upcomingMilestoneCount: number;
  daysToDeadline: number | null;
  schedulePace: SchedulePace;
  elapsedPct: number | null;
  resourceHours: { name: string; hours: number }[];
}

export interface ProjectSnapshot {
  sheetId: string;
  sheetUrl: string;
  name: string;
  startDate: string;
  endDate: string;
  buHead: string;
  trackerGenerated: boolean;
  deliverables: DeliverableSnapshot[];
  kpis: ProjectKpis;
}

export interface ProjectFetchError {
  sheetId: string;
  sheetUrl: string;
  label: string | null;
  error: string;
}

export interface RollupKpis {
  projectCount: number;
  ragCounts: Record<OverallRag, number>;
  avgTaskCompletionPct: number;
  totalOverdueTasks: number;
  totalBlockedTasks: number;
  totalUpcomingMilestones: number;
  resourceHours: { name: string; hours: number; projectCount: number }[];
}

// ─────────────────────────────── Fetching ───────────────────────────────

/**
 * Reads one tracker spreadsheet live (using the *viewer's own* OAuth token,
 * so this only works for sheets that person already has access to — either
 * they generated it, it was auto-shared to them as Business Unit Head, or
 * someone shared it by hand) and turns it into a structured snapshot plus
 * the computed KPI set for the dashboard.
 */
export async function fetchProjectSnapshot(accessToken: string, sheetIdOrUrl: string): Promise<ProjectSnapshot> {
  const spreadsheetId = extractSheetId(sheetIdOrUrl);
  const auth = buildAuthClient(accessToken);
  const sheets = google.sheets({ version: "v4", auth });

  const [meta, values] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title" }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [`'${EST_SHEET_NAME}'!A1:F1`, `'${TRACK_SHEET_NAME}'!A1:ZZ2000`],
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const title = meta.data.properties?.title ?? "Untitled Project";
  const name = title.replace(/\s*—\s*Project Plan & Tracker\s*$/, "").trim() || title;

  const estRow = (values.data.valueRanges?.[0]?.values?.[0] ?? []) as unknown[];
  const startDate = String(estRow[1] ?? "").trim();
  const endDate = String(estRow[3] ?? "").trim();
  const buHead = String(estRow[5] ?? "").trim();

  const trackRows = (values.data.valueRanges?.[1]?.values ?? []) as unknown[][];
  const { deliverables, trackerGenerated } = parseTrackingRows(trackRows);
  const kpis = computeKpis(deliverables, startDate, endDate);

  return {
    sheetId: spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    name,
    startDate,
    endDate,
    buHead,
    trackerGenerated,
    deliverables,
    kpis,
  };
}

// ─────────────────────────────── Parsing ───────────────────────────────

function parseTrackingRows(rows: unknown[][]): { deliverables: DeliverableSnapshot[]; trackerGenerated: boolean } {
  if (rows.length < 3) return { deliverables: [], trackerGenerated: false };

  const header1 = rows[0] ?? [];
  const slotLabels: string[] = [];
  for (let col = TRACK_LEADING_COLS; col < header1.length; col += TRACK_COLS_PER_TASK) {
    const label = String(header1[col] ?? "").trim();
    if (!label) break;
    slotLabels.push(label);
  }

  if (slotLabels.length === 0) return { deliverables: [], trackerGenerated: false };

  const today = startOfDay(new Date());
  const deliverables: DeliverableSnapshot[] = [];

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const delivName = String(row[0] ?? "").trim();
    if (!delivName) continue;

    const rag = String(row[8] ?? "").trim();
    const currentStage = String(row[9] ?? "").trim();
    const tasks: TaskSnapshot[] = [];

    slotLabels.forEach((label, idx) => {
      const baseCol = TRACK_LEADING_COLS + idx * TRACK_COLS_PER_TASK;
      const status = String(row[baseCol + 5] ?? "").trim();
      if (!status) return; // this deliverable has no task in this slot

      const assignedTo = String(row[baseCol + 0] ?? "").trim();
      const hoursRaw = row[baseCol + 1];
      const hours =
        hoursRaw !== undefined && hoursRaw !== null && String(hoursRaw).trim() !== "" && !isNaN(Number(hoursRaw))
          ? Number(hoursRaw)
          : null;
      const baseline = String(row[baseCol + 2] ?? "").trim();
      const plan = String(row[baseCol + 3] ?? "").trim();
      const actual = String(row[baseCol + 4] ?? "").trim();

      const completed = /^completed/i.test(status);
      const blocked = /^blocked/i.test(status);
      const baselineDate = parseDateOnly(baseline);
      const actualDate = parseDateOnly(actual);

      const overdue = !completed && baselineDate !== null && baselineDate.getTime() < today.getTime();
      const onTime = completed ? (baselineDate && actualDate ? actualDate.getTime() <= baselineDate.getTime() : null) : null;
      const upcoming =
        !completed &&
        baselineDate !== null &&
        baselineDate.getTime() >= today.getTime() &&
        baselineDate.getTime() <= addDays(today, UPCOMING_WINDOW_DAYS).getTime();

      tasks.push({
        slotLabel: label,
        assignedTo,
        hours,
        baseline,
        plan,
        actual,
        status,
        completed,
        blocked,
        overdue,
        onTime,
        upcoming,
      });
    });

    deliverables.push({ name: delivName, rag, currentStage, tasks });
  }

  return { deliverables, trackerGenerated: deliverables.length > 0 };
}

// ────────────────────────────── Date helpers ──────────────────────────────

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function addDays(d: Date, days: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

function parseDateOnly(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return startOfDay(d);
}

// ──────────────────────────── KPI computation ────────────────────────────

function computeKpis(deliverables: DeliverableSnapshot[], startDate: string, endDate: string): ProjectKpis {
  const allTasks = deliverables.flatMap((d) => d.tasks);
  const totalTasks = allTasks.length;
  const completedTasks = allTasks.filter((t) => t.completed).length;
  const overdueTaskCount = allTasks.filter((t) => t.overdue).length;
  const blockedTaskCount = allTasks.filter((t) => t.blocked).length;
  const upcomingMilestoneCount = allTasks.filter((t) => t.upcoming).length;

  const onTimeEligible = allTasks.filter((t) => t.completed && t.onTime !== null);
  const onTimeCount = onTimeEligible.filter((t) => t.onTime).length;
  const onTimeCompletionPct = onTimeEligible.length > 0 ? Math.round((onTimeCount / onTimeEligible.length) * 100) : null;

  const taskCompletionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  let overallRag: OverallRag = "Not Started";
  if (deliverables.length > 0) {
    const rags = deliverables.map((d) => d.rag);
    if (rags.some((r) => r === "Red")) overallRag = "Red";
    else if (rags.some((r) => r === "Amber")) overallRag = "Amber";
    else if (rags.length > 0 && rags.every((r) => r === "Green")) overallRag = "Green";
    else overallRag = "Gray";
  }

  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  const today = startOfDay(new Date());

  let daysToDeadline: number | null = null;
  let elapsedPct: number | null = null;
  let schedulePace: SchedulePace = "Unknown";

  if (end) {
    daysToDeadline = Math.round((end.getTime() - today.getTime()) / 86400000);
  }
  if (start && end && end.getTime() > start.getTime()) {
    const totalSpan = end.getTime() - start.getTime();
    const elapsed = Math.min(Math.max(today.getTime() - start.getTime(), 0), totalSpan);
    elapsedPct = Math.round((elapsed / totalSpan) * 100);
    if (totalTasks > 0) {
      const drift = elapsedPct - taskCompletionPct;
      if (drift > SCHEDULE_DRIFT_THRESHOLD) schedulePace = "Behind";
      else if (drift < -SCHEDULE_DRIFT_THRESHOLD) schedulePace = "Ahead";
      else schedulePace = "On Pace";
    }
  }

  const hoursMap = new Map<string, number>();
  allTasks.forEach((t) => {
    if (!t.assignedTo || t.hours === null) return;
    const key = t.assignedTo.trim();
    hoursMap.set(key, (hoursMap.get(key) ?? 0) + t.hours);
  });
  const resourceHours = Array.from(hoursMap.entries())
    .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours);

  return {
    overallRag,
    totalTasks,
    completedTasks,
    taskCompletionPct,
    onTimeCompletionPct,
    overdueTaskCount,
    blockedTaskCount,
    upcomingMilestoneCount,
    daysToDeadline,
    schedulePace,
    elapsedPct,
    resourceHours,
  };
}

// ─────────────────────────── Cross-project rollup ───────────────────────────

export function computeRollup(projects: ProjectSnapshot[]): RollupKpis {
  const ragCounts: Record<OverallRag, number> = { Red: 0, Amber: 0, Gray: 0, Green: 0, "Not Started": 0 };
  let completionSum = 0;
  let overdue = 0;
  let blocked = 0;
  let upcoming = 0;
  const hoursMap = new Map<string, { hours: number; projects: Set<string> }>();

  projects.forEach((p) => {
    ragCounts[p.kpis.overallRag] += 1;
    completionSum += p.kpis.taskCompletionPct;
    overdue += p.kpis.overdueTaskCount;
    blocked += p.kpis.blockedTaskCount;
    upcoming += p.kpis.upcomingMilestoneCount;
    p.kpis.resourceHours.forEach((r) => {
      const entry = hoursMap.get(r.name) ?? { hours: 0, projects: new Set<string>() };
      entry.hours += r.hours;
      entry.projects.add(p.sheetId);
      hoursMap.set(r.name, entry);
    });
  });

  const resourceHours = Array.from(hoursMap.entries())
    .map(([name, v]) => ({ name, hours: Math.round(v.hours * 10) / 10, projectCount: v.projects.size }))
    .sort((a, b) => b.hours - a.hours);

  return {
    projectCount: projects.length,
    ragCounts,
    avgTaskCompletionPct: projects.length > 0 ? Math.round(completionSum / projects.length) : 0,
    totalOverdueTasks: overdue,
    totalBlockedTasks: blocked,
    totalUpcomingMilestones: upcoming,
    resourceHours,
  };
}
