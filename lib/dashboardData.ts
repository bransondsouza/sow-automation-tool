import { google } from "googleapis";
import { extractSheetId } from "./googleSheets";

// Mirrors the column layout the Apps Script writes (see
// lib/googleAppsScript.ts) — kept as plain constants here rather than
// imported, since the script's copy runs inside Google's sandbox, not this
// codebase.
const EST_SHEET_NAME = "Estimation & Resource Allocation";
const TRACK_SHEET_NAME = "Project Tracking & Execution";
const FINANCIAL_HISTORY_SHEET_NAME = "Financial History";
const TRACK_LEADING_COLS = 10; // A Deliverable, B-H spare (7), I RAG, J Current Stage
// Assigned To, Hours, Baseline, Plan, Actual, Status, Dependency. Trackers
// generated before the Dependency column shipped had 6 — re-running
// "Generate Project Tracker" from the sheet's menu upgrades an existing
// tracker to this layout.
const TRACK_COLS_PER_TASK = 7;
const QUALITY_HEADER_LABEL = "Quality %";

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
  dependency: boolean; // true = "Dependent" on the task immediately before it
}

export interface DeliverableSnapshot {
  name: string;
  rag: string;
  currentStage: string;
  qualityPct: number | null; // PM-entered, trailing "Quality %" column; null if not set or column doesn't exist yet
  tasks: TaskSnapshot[];
}

// ─────────────────────── Financials, EVM, Critical Path ───────────────────────

export interface FinancialHistoryPoint {
  date: string;
  actualRevenue: number | null;
  actualSubconCost: number | null;
  actualResources: number | null;
}

export interface FinancialSnapshot {
  projectedRevenue: number | null;
  projectedSubconCost: number | null;
  projectedResources: number | null;
  actualRevenue: number | null;
  actualSubconCost: number | null;
  actualResources: number | null;
  // true when the actual value has been entered AND differs from the
  // projected value — drives the red/green indicator on the dashboard.
  revenueChanged: boolean;
  subconCostChanged: boolean;
  resourcesChanged: boolean;
  history: FinancialHistoryPoint[]; // weekly snapshots from the Financial History tab
}

export interface EvmSnapshot {
  plannedValue: number | null; // PV = Projected Subcon Cost × % time elapsed
  earnedValue: number | null; // EV = Projected Subcon Cost × % tasks complete
  actualCost: number | null; // AC = latest Actual Subcon Cost
  scheduleVariance: number | null; // SV = EV − PV
  costVariance: number | null; // CV = EV − AC
  revenueVariance: number | null; // Actual Revenue − (Projected Revenue × % tasks complete)
}

export interface CriticalChain {
  deliverableName: string;
  taskLabels: string[]; // in chain order
  startDate: string | null; // first task's Baseline Date
  finishDate: string | null; // last task's Baseline Date
  slackDays: number | null; // Project End Date − finish date; smaller = more at-risk
  critical: boolean; // true for the minimum-slack chain(s) in the project
}

// This is a simplified/derived critical path, NOT a textbook duration-based
// CPM network: it groups each deliverable's tasks into "chains" (maximal
// runs of consecutive Dependent-flagged tasks) using the tracker's real
// Baseline Dates, rather than computing task durations and a dependency
// graph from scratch. A chain's slack is how many days of buffer it has
// before the Project End Date; the chain(s) with the least slack are
// flagged critical. See SHEETS_TRACKER.md.

export type OverallRag = "Red" | "Amber" | "Gray" | "Green" | "Not Started";
export type SchedulePace = "Ahead" | "On Pace" | "Behind" | "Unknown";

export interface StatusCount {
  status: string;
  count: number;
}

export interface BurndownPoint {
  date: string; // yyyy-mm-dd
  idealPct: number;
  actualPct: number;
}

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
  statusBreakdown: StatusCount[];
  burndown: BurndownPoint[];
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
  financials: FinancialSnapshot;
  evm: EvmSnapshot;
  criticalChains: CriticalChain[];
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
  totalTasks: number;
  totalOverdueTasks: number;
  totalBlockedTasks: number;
  totalUpcomingMilestones: number;
  resourceHours: { name: string; hours: number; projectCount: number }[];
  statusBreakdown: StatusCount[];
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

  const [meta, coreValues] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title" }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [`'${EST_SHEET_NAME}'!A1:L2`, `'${TRACK_SHEET_NAME}'!A1:ZZ2000`],
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const title = meta.data.properties?.title ?? "Untitled Project";
  const name = title.replace(/\s*—\s*Project Plan & Tracker\s*$/, "").trim() || title;

  const estRows = (coreValues.data.valueRanges?.[0]?.values ?? []) as unknown[][];
  const estRow1 = estRows[0] ?? [];
  const estRow2 = estRows[1] ?? [];
  const startDate = String(estRow1[1] ?? "").trim();
  const endDate = String(estRow1[3] ?? "").trim();
  const buHead = String(estRow1[5] ?? "").trim();

  const trackRows = (coreValues.data.valueRanges?.[1]?.values ?? []) as unknown[][];
  const { deliverables, trackerGenerated } = parseTrackingRows(trackRows);
  const kpis = computeKpis(deliverables, startDate, endDate);

  // Financial History is only present on trackers generated after this
  // feature shipped — fetched separately (and swallowed on failure) so an
  // older tracker without the tab doesn't break the whole dashboard fetch.
  let historyRows: unknown[][] = [];
  try {
    const historyValues = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${FINANCIAL_HISTORY_SHEET_NAME}'!A1:D500`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    historyRows = (historyValues.data.values ?? []) as unknown[][];
  } catch {
    historyRows = [];
  }

  const financials = computeFinancials(estRow1, estRow2, historyRows);
  const evm = computeEvm(financials, kpis);
  const criticalChains = computeCriticalPath(deliverables, endDate);

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
    financials,
    evm,
    criticalChains,
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

  // The trailing Quality % column sits right after the last task block —
  // found by its header label (not a fixed offset) so a tracker generated
  // before this column existed just reports qualityPct: null everywhere.
  let qualityCol = -1;
  for (let col = 0; col < header1.length; col++) {
    if (String(header1[col] ?? "").trim() === QUALITY_HEADER_LABEL) {
      qualityCol = col;
      break;
    }
  }

  const today = startOfDay(new Date());
  const deliverables: DeliverableSnapshot[] = [];

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const delivName = String(row[0] ?? "").trim();
    if (!delivName) continue;

    const rag = String(row[8] ?? "").trim();
    const currentStage = String(row[9] ?? "").trim();
    const qualityPct = qualityCol >= 0 ? parseNumeric(row[qualityCol]) : null;
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
      const dependency = String(row[baseCol + 6] ?? "").trim().toLowerCase() === "dependent";

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
        dependency,
      });
    });

    deliverables.push({ name: delivName, rag, currentStage, qualityPct, tasks });
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

// Strips currency/thousands formatting (e.g. "1,234.50 ") down to a plain
// number — needed because Sheets values are fetched with FORMATTED_VALUE.
function parseNumeric(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (str === "") return null;
  const cleaned = str.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
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

  const statusMap = new Map<string, number>();
  allTasks.forEach((t) => {
    const key = t.status || "Unknown";
    statusMap.set(key, (statusMap.get(key) ?? 0) + 1);
  });
  const statusBreakdown = Array.from(statusMap.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const burndown = computeBurndown(allTasks, start, end);

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
    statusBreakdown,
    burndown,
  };
}

// Ideal-pace vs actual-completion series from Project Start to Project End —
// the "burndown" (really a burn-UP, cumulative % complete) chart on the
// dashboard. Sampled roughly weekly, capped at a sane number of points so a
// multi-year project doesn't produce hundreds of them.
function computeBurndown(allTasks: TaskSnapshot[], start: Date | null, end: Date | null): BurndownPoint[] {
  const totalTasks = allTasks.length;
  if (!start || !end || totalTasks === 0 || end.getTime() <= start.getTime()) return [];

  const dayMs = 86400000;
  const spanDays = Math.round((end.getTime() - start.getTime()) / dayMs);
  if (spanDays <= 0) return [];

  const maxPoints = 14;
  const stepDays = Math.max(1, Math.ceil(spanDays / maxPoints));

  const actualDates = allTasks
    .map((t) => parseDateOnly(t.actual))
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime())
    .sort((a, b) => a - b);

  function completedByTime(timeMs: number): number {
    // actualDates is sorted — count how many are <= timeMs.
    let count = 0;
    for (const t of actualDates) {
      if (t <= timeMs) count++;
      else break;
    }
    return count;
  }

  const points: BurndownPoint[] = [];
  for (let d = 0; d <= spanDays; d += stepDays) {
    const pointDate = addDays(start, d);
    const idealPct = Math.round((d / spanDays) * 100);
    const actualPct = Math.round((completedByTime(pointDate.getTime()) / totalTasks) * 100);
    points.push({ date: pointDate.toISOString().slice(0, 10), idealPct, actualPct });
  }

  const lastPoint = points[points.length - 1];
  const endStr = end.toISOString().slice(0, 10);
  if (!lastPoint || lastPoint.date !== endStr) {
    const actualPct = Math.round((completedByTime(end.getTime()) / totalTasks) * 100);
    points.push({ date: endStr, idealPct: 100, actualPct });
  }

  return points;
}

// ────────────────────── Financials, EVM, Critical Path ──────────────────────

// estRow1 = Estimation row 1 (Start/End/BU Head + Projected G-L), estRow2 =
// row 2 (Actual G-L). Columns: G(6)/H(7) Revenue, I(8)/J(9) Subcon Cost,
// K(10)/L(11) Resources — label/value pairs, so the value is always the odd
// index. See lib/googleSheets.ts's column-mapping comment for the source of
// truth on this layout.
function computeFinancials(estRow1: unknown[], estRow2: unknown[], historyRows: unknown[][]): FinancialSnapshot {
  const projectedRevenue = parseNumeric(estRow1[7]);
  const projectedSubconCost = parseNumeric(estRow1[9]);
  const projectedResources = parseNumeric(estRow1[11]);
  const actualRevenue = parseNumeric(estRow2[7]);
  const actualSubconCost = parseNumeric(estRow2[9]);
  const actualResources = parseNumeric(estRow2[11]);

  // Only flags a change once an actual value has actually been entered —
  // an empty Actual cell isn't "no change", it's "not reported yet".
  const changed = (projected: number | null, actual: number | null): boolean =>
    projected !== null && actual !== null && Math.round(projected * 100) !== Math.round(actual * 100);

  const history: FinancialHistoryPoint[] = historyRows
    .slice(1) // header row
    .map((r) => ({
      date: String(r[0] ?? "").trim(),
      actualRevenue: parseNumeric(r[1]),
      actualSubconCost: parseNumeric(r[2]),
      actualResources: parseNumeric(r[3]),
    }))
    .filter((p) => p.date !== "");

  return {
    projectedRevenue,
    projectedSubconCost,
    projectedResources,
    actualRevenue,
    actualSubconCost,
    actualResources,
    revenueChanged: changed(projectedRevenue, actualRevenue),
    subconCostChanged: changed(projectedSubconCost, actualSubconCost),
    resourcesChanged: changed(projectedResources, actualResources),
    history,
  };
}

function computeEvm(financials: FinancialSnapshot, kpis: ProjectKpis): EvmSnapshot {
  const { projectedSubconCost, actualSubconCost, projectedRevenue, actualRevenue } = financials;
  const elapsedFrac = kpis.elapsedPct !== null ? kpis.elapsedPct / 100 : null;
  const completeFrac = kpis.taskCompletionPct / 100;

  const plannedValue = projectedSubconCost !== null && elapsedFrac !== null ? projectedSubconCost * elapsedFrac : null;
  const earnedValue = projectedSubconCost !== null ? projectedSubconCost * completeFrac : null;
  const actualCost = actualSubconCost;

  const scheduleVariance = earnedValue !== null && plannedValue !== null ? earnedValue - plannedValue : null;
  const costVariance = earnedValue !== null && actualCost !== null ? earnedValue - actualCost : null;
  const revenueVariance =
    actualRevenue !== null && projectedRevenue !== null ? actualRevenue - projectedRevenue * completeFrac : null;

  return { plannedValue, earnedValue, actualCost, scheduleVariance, costVariance, revenueVariance };
}

// Groups each deliverable's tasks into chains — a new chain starts at every
// Non-dependent task, and consecutive Dependent tasks extend the current
// chain — then scores each chain's slack against the Project End Date. See
// the CriticalChain doc comment above for why this is "lite," not textbook
// CPM.
function computeCriticalPath(deliverables: DeliverableSnapshot[], endDate: string): CriticalChain[] {
  const end = parseDateOnly(endDate);
  const chains: CriticalChain[] = [];

  deliverables.forEach((d) => {
    let current: TaskSnapshot[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const startTask = current[0];
      const finishTask = current[current.length - 1];
      const finishDate = parseDateOnly(finishTask.baseline);
      const slackDays = end && finishDate ? Math.round((end.getTime() - finishDate.getTime()) / 86400000) : null;
      chains.push({
        deliverableName: d.name,
        taskLabels: current.map((t) => t.slotLabel),
        startDate: startTask.baseline || null,
        finishDate: finishTask.baseline || null,
        slackDays,
        critical: false, // set below, once every chain's slack is known
      });
      current = [];
    };

    d.tasks.forEach((t) => {
      if (!t.dependency && current.length > 0) flush();
      current.push(t);
    });
    flush();
  });

  const knownSlacks = chains.map((c) => c.slackDays).filter((s): s is number => s !== null);
  if (knownSlacks.length > 0) {
    const minSlack = Math.min(...knownSlacks);
    chains.forEach((c) => {
      if (c.slackDays === minSlack) c.critical = true;
    });
  }

  return chains.sort((a, b) => (a.slackDays ?? Infinity) - (b.slackDays ?? Infinity));
}

// ─────────────────────────── Cross-project rollup ───────────────────────────

export function computeRollup(projects: ProjectSnapshot[]): RollupKpis {
  const ragCounts: Record<OverallRag, number> = { Red: 0, Amber: 0, Gray: 0, Green: 0, "Not Started": 0 };
  let completionSum = 0;
  let totalTasks = 0;
  let overdue = 0;
  let blocked = 0;
  let upcoming = 0;
  const hoursMap = new Map<string, { hours: number; projects: Set<string> }>();
  const statusMap = new Map<string, number>();

  projects.forEach((p) => {
    ragCounts[p.kpis.overallRag] += 1;
    completionSum += p.kpis.taskCompletionPct;
    totalTasks += p.kpis.totalTasks;
    overdue += p.kpis.overdueTaskCount;
    blocked += p.kpis.blockedTaskCount;
    upcoming += p.kpis.upcomingMilestoneCount;
    p.kpis.resourceHours.forEach((r) => {
      const entry = hoursMap.get(r.name) ?? { hours: 0, projects: new Set<string>() };
      entry.hours += r.hours;
      entry.projects.add(p.sheetId);
      hoursMap.set(r.name, entry);
    });
    p.kpis.statusBreakdown.forEach((s) => {
      statusMap.set(s.status, (statusMap.get(s.status) ?? 0) + s.count);
    });
  });

  const resourceHours = Array.from(hoursMap.entries())
    .map(([name, v]) => ({ name, hours: Math.round(v.hours * 10) / 10, projectCount: v.projects.size }))
    .sort((a, b) => b.hours - a.hours);

  const statusBreakdown = Array.from(statusMap.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return {
    projectCount: projects.length,
    ragCounts,
    avgTaskCompletionPct: projects.length > 0 ? Math.round(completionSum / projects.length) : 0,
    totalTasks,
    totalOverdueTasks: overdue,
    totalBlockedTasks: blocked,
    totalUpcomingMilestones: upcoming,
    resourceHours,
    statusBreakdown,
  };
}
