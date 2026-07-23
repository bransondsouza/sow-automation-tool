import { google } from "googleapis";
import { fetchProjectSnapshot, ProjectSnapshot } from "./dashboardData";
import { sendTaskAlertEmail, TaskAlertLine } from "./gmail";
import { postAlertDigestToGoogleChat, AlertDigestSummary } from "./googleChat";

// Daily task alerts: delayed tasks, tasks still Yet to Start after their own
// Plan Date has passed, and tasks due today. Run once a day, per project, by
// the cron route (app/api/cron/daily-alerts) — see that file and
// DASHBOARD.md's "Daily Task Alerts" section for the full design.
//
// Deliberately stateless: this recomputes and resends every day a task is
// still flagged, rather than tracking "already alerted" anywhere. Simpler,
// and matches the confirmed design decision — a task that's still overdue
// tomorrow should still show up tomorrow, not go quiet just because someone
// got one email about it already.

// Mirrors lib/googleSheets.ts's Lists tab layout (that file is the source of
// truth for the sheet's structure) — column B is the team roster, column C
// is that person's email, both starting at row 2. See SHEETS_TRACKER.md's
// "Tab 3: Lists" section.
const LISTS_SHEET_NAME = "Lists";
const LIST_ROOM_ROWS = 30; // Lists!B2:B31 / C2:C31

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

/**
 * Reads the Lists tab roster (name → email), skipping any row with a blank
 * or not-quite-an-email value. Per SHEETS_TRACKER.md: a blank email is how
 * someone opts out of alerts — there's no separate on/off setting.
 */
export async function fetchRosterEmails(accessToken: string, sheetId: string): Promise<Map<string, string>> {
  const auth = buildAuthClient(accessToken);
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${LISTS_SHEET_NAME}'!B2:C${LIST_ROOM_ROWS + 1}`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = (res.data.values ?? []) as unknown[][];
  const map = new Map<string, string>();
  rows.forEach((row) => {
    const name = String(row[0] ?? "").trim();
    const email = String(row[1] ?? "").trim();
    if (name && email && EMAIL_RE.test(email)) map.set(name, email);
  });
  return map;
}

// ─────────────────────────── Detection ───────────────────────────

export type AlertCategory = "delayed" | "ytsWithPlan" | "dueToday";

export const CATEGORY_LABEL: Record<AlertCategory, string> = {
  delayed: "Delayed (past its Baseline Date)",
  ytsWithPlan: "Yet to Start, past its Plan Date",
  dueToday: "Due today",
};

export interface AlertItem {
  deliverableName: string;
  slotLabel: string;
  assignedTo: string;
  status: string;
  category: AlertCategory;
  effectiveDate: string; // the date driving this alert
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function parseDateOnly(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return startOfDay(d);
}

/**
 * Finds every task in a project that should trigger a daily alert. Each
 * task lands in exactly ONE category — checked in priority order Delayed >
 * Yet-to-Start-past-Plan > Due-Today — so nobody sees the same task listed
 * twice in one digest just because it happens to match more than one rule.
 *
 * "Due today" uses Plan Date if the task has one, else Baseline Date — the
 * confirmed design decision: a task with no Plan Date entered yet is still
 * "due" against its automatically computed Baseline schedule.
 */
export function findAlertTasks(project: ProjectSnapshot): AlertItem[] {
  const today = startOfDay(new Date());
  const items: AlertItem[] = [];

  project.deliverables.forEach((d) => {
    d.tasks.forEach((t) => {
      if (t.completed || !t.assignedTo) return;

      // 1. Delayed — the same "overdue" signal already computed for the
      //    dashboard (not completed, Baseline Date in the past).
      if (t.overdue) {
        items.push({
          deliverableName: d.name,
          slotLabel: t.slotLabel,
          assignedTo: t.assignedTo,
          status: t.status,
          category: "delayed",
          effectiveDate: t.baseline,
        });
        return;
      }

      // 2. Yet to Start, but its own Plan Date has already passed.
      const isYts = t.status.trim().toUpperCase() === "YTS";
      const planDate = parseDateOnly(t.plan);
      if (isYts && planDate && planDate.getTime() < today.getTime()) {
        items.push({
          deliverableName: d.name,
          slotLabel: t.slotLabel,
          assignedTo: t.assignedTo,
          status: t.status,
          category: "ytsWithPlan",
          effectiveDate: t.plan,
        });
        return;
      }

      // 3. Due today — Plan Date if set, else Baseline Date.
      const effective = t.plan ? planDate : parseDateOnly(t.baseline);
      if (effective && effective.getTime() === today.getTime()) {
        items.push({
          deliverableName: d.name,
          slotLabel: t.slotLabel,
          assignedTo: t.assignedTo,
          status: t.status,
          category: "dueToday",
          effectiveDate: t.plan || t.baseline,
        });
      }
    });
  });

  return items;
}

// ─────────────────────────── Grouping + sending ───────────────────────────

export interface AssigneeDigest {
  assignedTo: string;
  email: string;
  items: AlertItem[];
}

/** Groups flagged tasks by assignee, dropping anyone with no email on the Lists tab. */
export function groupByAssignee(items: AlertItem[], roster: Map<string, string>): AssigneeDigest[] {
  const byName = new Map<string, AlertItem[]>();
  items.forEach((item) => {
    const list = byName.get(item.assignedTo) ?? [];
    list.push(item);
    byName.set(item.assignedTo, list);
  });

  const digests: AssigneeDigest[] = [];
  byName.forEach((list, name) => {
    const email = roster.get(name);
    if (!email) return; // no email on file — this person doesn't get alerted
    digests.push({ assignedTo: name, email, items: list });
  });
  return digests;
}

export interface ProjectAlertResult {
  sheetId: string;
  projectName: string;
  totalFlagged: number;
  emailsSent: number;
  emailsFailed: number;
  chat: { attempted: boolean; ok: boolean; error?: string };
  error?: string;
}

/**
 * Runs the full daily alert check for one project: reads the tracker and
 * roster live, finds flagged tasks, emails each assignee their own digest,
 * and (if a Chat webhook is configured for this dashboard link) posts a
 * one-message summary. Every send is best-effort and independent — one
 * failed email never blocks another person's email or the Chat post.
 */
export async function runProjectAlerts(
  accessToken: string,
  sheetId: string,
  chatWebhookUrl: string | null
): Promise<ProjectAlertResult> {
  let snapshot: ProjectSnapshot;
  try {
    snapshot = await fetchProjectSnapshot(accessToken, sheetId);
  } catch (err) {
    return {
      sheetId,
      projectName: sheetId,
      totalFlagged: 0,
      emailsSent: 0,
      emailsFailed: 0,
      chat: { attempted: false, ok: false },
      error: err instanceof Error ? err.message : "Could not read the tracker sheet.",
    };
  }

  if (!snapshot.trackerGenerated) {
    return {
      sheetId,
      projectName: snapshot.name,
      totalFlagged: 0,
      emailsSent: 0,
      emailsFailed: 0,
      chat: { attempted: false, ok: false },
    };
  }

  const items = findAlertTasks(snapshot);

  let roster = new Map<string, string>();
  try {
    roster = await fetchRosterEmails(accessToken, sheetId);
  } catch (err) {
    console.error(`Daily alerts: could not read the roster for ${sheetId}:`, err);
  }

  const digests = groupByAssignee(items, roster);

  let emailsSent = 0;
  let emailsFailed = 0;
  for (const digest of digests) {
    const lines: TaskAlertLine[] = digest.items.map((item) => ({
      deliverableName: item.deliverableName,
      slotLabel: item.slotLabel,
      categoryLabel: CATEGORY_LABEL[item.category],
      effectiveDate: item.effectiveDate,
      status: item.status,
    }));
    try {
      await sendTaskAlertEmail({
        accessToken,
        to: digest.email,
        assignedToName: digest.assignedTo,
        projectName: snapshot.name,
        sheetUrl: snapshot.sheetUrl,
        lines,
      });
      emailsSent++;
    } catch (err) {
      emailsFailed++;
      console.error(`Daily alerts: email failed for ${digest.assignedTo} <${digest.email}> on ${sheetId}:`, err);
    }
  }

  const chat: ProjectAlertResult["chat"] = { attempted: false, ok: false };
  if (chatWebhookUrl && items.length > 0) {
    chat.attempted = true;
    const summary: AlertDigestSummary = {
      delayedCount: items.filter((i) => i.category === "delayed").length,
      ytsWithPlanCount: items.filter((i) => i.category === "ytsWithPlan").length,
      dueTodayCount: items.filter((i) => i.category === "dueToday").length,
      byAssignee: digests.map((d) => ({ name: d.assignedTo, count: d.items.length })),
    };
    try {
      await postAlertDigestToGoogleChat(chatWebhookUrl, snapshot.name, snapshot.sheetUrl, summary);
      chat.ok = true;
    } catch (err) {
      chat.error = err instanceof Error ? err.message : "Could not reach that Chat webhook.";
      console.error(`Daily alerts: Chat webhook failed for ${sheetId}:`, err);
    }
  }

  return {
    sheetId,
    projectName: snapshot.name,
    totalFlagged: items.length,
    emailsSent,
    emailsFailed,
    chat,
  };
}
