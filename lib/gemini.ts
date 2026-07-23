import { GoogleGenAI } from "@google/genai";
import { ProjectSnapshot } from "./dashboardData";

// Deliberately Gemini, not Claude (lib/claude.ts, used for SOW extraction
// elsewhere in this app) — the risk bot was specifically asked to run on
// Gemini, since this app is expected to move onto the company's Gemini/
// internal-LLM stack later. Keeping it in its own file, behind its own
// function signature, is what makes that swap a contained change when it
// happens.
//
// GEMINI_MODEL defaults to Google's rolling "latest Flash" alias rather
// than a pinned dated model, so this doesn't quietly break the day Google
// retires whatever specific version was current when this was written —
// same reasoning as ANTHROPIC_MODEL's default in lib/claude.ts.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

function buildClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  return new GoogleGenAI({ apiKey });
}

const SYSTEM_INSTRUCTION = `You are a project management risk assistant embedded in a live project tracking dashboard. At the start of this conversation you were given the CURRENT live status of one specific project — overdue/blocked tasks, schedule pace, cost/schedule variance, critical path, and similar — as grounding context.

Your two jobs:
1. When asked to analyze risks, identify and classify the most significant risks visible in the data you were given (e.g. Schedule Risk, Resource Risk, Cost Risk, Quality Risk, Dependency Risk), each with a specific, actionable mitigation. Ground every claim in the actual task/deliverable names and figures provided — never invent facts not present in the context, and never give vague advice like "monitor closely."
2. Answer general project management best-practice questions the user asks, drawing on standard PMI-aligned methodology.

Rules:
- If the data shows no significant risk signals (e.g. no overdue or blocked tasks, positive variance), say so plainly rather than manufacturing a risk to report.
- Keep answers concise and scannable — short paragraphs or a short bulleted list, not an essay.
- Format as PLAIN TEXT ONLY — no markdown. No asterisks/underscores for bold or italics, no "#" headers, no markdown tables. For a list, start each line with "- ". The interface that displays your reply does not render markdown, so any of those symbols would show up literally.
- You are not a lawyer or financial advisor; keep cost/schedule commentary framed as PM analysis, not financial advice.
- If asked something with no connection to this project or to project management, say that's outside what you're here to help with.`;

export interface ChatTurn {
  role: "user" | "bot";
  text: string;
}

// The auto-run prompt the dashboard sends the moment the risk panel opens,
// before the user has typed anything — exported so the API route sends the
// exact same wording the system instruction above was written against.
export const ANALYZE_RISKS_PROMPT =
  "Analyze the current risks in this project based on the status you were given. Identify and classify each risk, and give a specific, actionable mitigation for each. If there's genuinely nothing significant to flag, say so.";

/**
 * Sends one turn to the risk bot: the live project context (re-sent as the
 * first turn every call, since this is a stateless HTTP API — there's no
 * server-side session to hold it between requests), the conversation so
 * far, and the new message. Returns the bot's reply as plain text.
 */
export async function askRiskBot(contextSummary: string, history: ChatTurn[], message: string): Promise<string> {
  const ai = buildClient();

  const contents = [
    { role: "user", parts: [{ text: `Here is the current live status of this project:\n\n${contextSummary}` }] },
    { role: "model", parts: [{ text: "Understood — I have the current project status. What would you like to know?" }] },
    ...history.map((turn) => ({
      role: turn.role === "user" ? "user" : "model",
      parts: [{ text: turn.text }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction: SYSTEM_INSTRUCTION },
  });

  const text = response.text;
  if (!text || !text.trim()) {
    throw new Error("Gemini did not return a response. Please try again.");
  }
  return text.trim();
}

// Builds the plain-text status block the bot is grounded in. Kept separate
// from askRiskBot so the API route can build it once per request and (if
// useful later) log/inspect it independently of the actual Gemini call.
export function buildRiskContext(project: ProjectSnapshot): string {
  const k = project.kpis;
  const lines: string[] = [];

  lines.push(`Project: ${project.name}`);
  lines.push(`Overall Health (RAG): ${k.overallRag}`);
  lines.push(`Task Completion: ${k.taskCompletionPct}% (${k.completedTasks} of ${k.totalTasks} tasks)`);
  lines.push(
    `Schedule Pace: ${k.schedulePace}` +
      (k.elapsedPct !== null ? ` (${k.elapsedPct}% of project time elapsed vs ${k.taskCompletionPct}% of tasks complete)` : "")
  );
  if (k.daysToDeadline !== null) lines.push(`Days to Deadline: ${k.daysToDeadline}`);
  lines.push(`Overdue Tasks: ${k.overdueTaskCount}`);
  lines.push(`Blocked Tasks: ${k.blockedTaskCount}`);
  lines.push(`Upcoming Milestones (next 7 days): ${k.upcomingMilestoneCount}`);

  const allTasks = project.deliverables.flatMap((d) => d.tasks.map((t) => ({ ...t, deliverable: d.name })));
  const overdue = allTasks.filter((t) => t.overdue);
  const blocked = allTasks.filter((t) => t.blocked);
  const ytsWithPlan = allTasks.filter((t) => !t.completed && (t.status || "").trim().toUpperCase() === "YTS" && t.plan);

  const MAX_LISTED = 25;

  if (overdue.length > 0) {
    lines.push("\nOverdue tasks:");
    overdue.slice(0, MAX_LISTED).forEach((t) => {
      lines.push(`- ${t.deliverable} / ${t.slotLabel} — assigned to ${t.assignedTo || "unassigned"}, baseline ${t.baseline || "?"}, status "${t.status || "?"}"`);
    });
    if (overdue.length > MAX_LISTED) lines.push(`  ...and ${overdue.length - MAX_LISTED} more overdue task(s).`);
  }

  if (blocked.length > 0) {
    lines.push("\nBlocked tasks:");
    blocked.slice(0, MAX_LISTED).forEach((t) => {
      lines.push(`- ${t.deliverable} / ${t.slotLabel} — assigned to ${t.assignedTo || "unassigned"}, status "${t.status || "?"}"`);
    });
    if (blocked.length > MAX_LISTED) lines.push(`  ...and ${blocked.length - MAX_LISTED} more blocked task(s).`);
  }

  if (ytsWithPlan.length > 0) {
    lines.push("\nYet-to-start tasks that already have a Plan Date set:");
    ytsWithPlan.slice(0, MAX_LISTED).forEach((t) => {
      lines.push(`- ${t.deliverable} / ${t.slotLabel} — plan date ${t.plan}`);
    });
    if (ytsWithPlan.length > MAX_LISTED) lines.push(`  ...and ${ytsWithPlan.length - MAX_LISTED} more.`);
  }

  const f = project.financials;
  if (f.projectedSubconCost !== null || f.projectedRevenue !== null) {
    lines.push("\nFinancials:");
    if (f.projectedRevenue !== null) lines.push(`- Revenue — Projected $${f.projectedRevenue}, Actual ${f.actualRevenue !== null ? `$${f.actualRevenue}` : "not yet reported"}`);
    if (f.projectedSubconCost !== null) lines.push(`- Subcon Cost — Projected $${f.projectedSubconCost}, Actual ${f.actualSubconCost !== null ? `$${f.actualSubconCost}` : "not yet reported"}`);
    const e = project.evm;
    if (e.scheduleVariance !== null) lines.push(`- Schedule Variance (SV): ${e.scheduleVariance >= 0 ? "+" : ""}$${Math.round(e.scheduleVariance)} (positive = ahead of schedule)`);
    if (e.costVariance !== null) lines.push(`- Cost Variance (CV): ${e.costVariance >= 0 ? "+" : ""}$${Math.round(e.costVariance)} (positive = under budget)`);
  }

  const criticalChains = project.criticalChains.filter((c) => c.critical);
  if (criticalChains.length > 0) {
    lines.push("\nCritical path — chain(s) with the least schedule slack:");
    criticalChains.slice(0, 10).forEach((c) => {
      lines.push(`- ${c.deliverableName}: ${c.taskLabels.join(" → ")} (slack ${c.slackDays ?? "unknown"} day(s) before Project End Date)`);
    });
  }

  const lowQuality = project.deliverables.filter((d) => d.qualityPct !== null && d.qualityPct < 80);
  if (lowQuality.length > 0) {
    lines.push("\nDeliverables with Quality % below 80:");
    lowQuality.forEach((d) => lines.push(`- ${d.name}: ${d.qualityPct}%`));
  }

  return lines.join("\n");
}
