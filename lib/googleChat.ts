import type { ProjectSnapshot } from "./dashboardData";
import type { GeneratedReport } from "./statusReport";

/**
 * Posts a status-report notification to a Google Chat space using a plain
 * incoming webhook URL (Space → Apps & integrations → Webhooks → create
 * one → copy the URL). Deliberately NOT the OAuth Chat API — that requires
 * registering and publishing a full Chat app just to post a message, which
 * is overkill for "ping the team." A webhook URL is itself the credential;
 * anyone with the link can post to that space, so it's saved per-dashboard
 * (like a sheet link), not shared globally.
 */
export async function postToGoogleChat(webhookUrl: string, snapshot: ProjectSnapshot, report: GeneratedReport): Promise<void> {
  const k = snapshot.kpis;
  const ragEmoji: Record<string, string> = {
    Red: "🔴",
    Amber: "🟠",
    Green: "🟢",
    Gray: "⚪",
  };

  const lines = [
    `*Client Status Report ready — ${snapshot.name}*`,
    "",
    `${ragEmoji[k.overallRag] ?? "⚪"} Overall Health: *${k.overallRag}*`,
    `Task Completion: ${k.taskCompletionPct}% (${k.completedTasks}/${k.totalTasks})`,
    `Overdue: ${k.overdueTaskCount} · Blocked: ${k.blockedTaskCount} · Upcoming (7d): ${k.upcomingMilestoneCount}`,
    "",
    `<${report.url}|Open the Slides deck>`,
  ];

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text: lines.join("\n") }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google Chat webhook responded ${response.status}: ${body.slice(0, 300)}`);
  }
}

export interface AlertDigestSummary {
  delayedCount: number;
  ytsWithPlanCount: number;
  dueTodayCount: number;
  byAssignee: { name: string; count: number }[];
}

/**
 * Posts the daily task-alert digest to a project's Chat webhook (same
 * webhook field as the Client Status Report — set once per dashboard link,
 * reused for both). One message per project per day, summarizing counts
 * rather than every task line, so the space doesn't get spammed.
 */
export async function postAlertDigestToGoogleChat(
  webhookUrl: string,
  projectName: string,
  sheetUrl: string,
  summary: AlertDigestSummary
): Promise<void> {
  const total = summary.delayedCount + summary.ytsWithPlanCount + summary.dueTodayCount;

  const lines = [
    `*Daily task alert — ${projectName}*`,
    "",
    `⏰ ${total} task${total === 1 ? "" : "s"} flagged today`,
    `Delayed: ${summary.delayedCount} · Yet to Start (past Plan Date): ${summary.ytsWithPlanCount} · Due today: ${summary.dueTodayCount}`,
  ];

  if (summary.byAssignee.length > 0) {
    lines.push("", "By person:");
    summary.byAssignee.forEach((a) => lines.push(`- ${a.name}: ${a.count}`));
  }

  lines.push("", `<${sheetUrl}|Open the tracker>`);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text: lines.join("\n") }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google Chat webhook responded ${response.status}: ${body.slice(0, 300)}`);
  }
}
