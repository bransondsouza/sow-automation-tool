import { google } from "googleapis";
import type { ProjectSnapshot } from "./dashboardData";
import type { GeneratedReport } from "./statusReport";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "status-report";
}

function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

function buildMimeMessage(opts: { to: string[]; subject: string; htmlBody: string; attachment?: MimeAttachment }): Buffer {
  const boundary = `report_${Math.random().toString(36).slice(2)}_${Date.now()}`;

  const headers = [
    `To: ${opts.to.join(", ")}`,
    `Subject: ${encodeSubject(opts.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ];

  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.htmlBody,
    "",
  ];

  if (opts.attachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${opts.attachment.mimeType}; name="${opts.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      opts.attachment.data.toString("base64").replace(/(.{76})/g, "$1\n"),
      ""
    );
  }

  parts.push(`--${boundary}--`, "");

  return Buffer.from([...headers, ...parts].join("\r\n"), "utf-8");
}

/** Splits a free-typed recipients field ("a@x.com, b@y.com; c@z.com") into valid addresses. */
export function parseRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export interface SendReportEmailOptions {
  accessToken: string;
  to: string[];
  snapshot: ProjectSnapshot;
  report: GeneratedReport;
}

/**
 * Sends the status report as the signed-in employee's own Gmail (not a
 * shared mailbox) — a new message only, nothing is read or searched in
 * their inbox. Exports the just-generated Slides deck to PDF via Drive so
 * recipients see the full report without needing a Google account or edit
 * access; the live deck link is included too. If the PDF export fails for
 * any reason, the email still sends with just the link — this step is
 * meant to be non-fatal.
 */
export async function sendStatusReportEmail({ accessToken, to, snapshot, report }: SendReportEmailOptions): Promise<void> {
  if (to.length === 0) return;

  const auth = buildAuthClient(accessToken);
  const drive = google.drive({ version: "v3", auth });
  const gmail = google.gmail({ version: "v1", auth });

  let pdfBuffer: Buffer | null = null;
  try {
    const exportResponse = await drive.files.export(
      { fileId: report.presentationId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    pdfBuffer = Buffer.from(exportResponse.data as ArrayBuffer);
  } catch (error) {
    console.error("Failed to export status report to PDF — sending the email without an attachment:", error);
  }

  const k = snapshot.kpis;
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; color: #1a1a1a; max-width: 560px;">
      <h2 style="color:#1d4e6d; margin-bottom: 4px;">${escapeHtml(snapshot.name)}</h2>
      <p style="color:#5c7487; margin-top: 0;">Client Status Report &middot; ${today}</p>
      <table style="border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding:4px 12px 4px 0; color:#5c7487;">Overall Health</td><td><strong>${escapeHtml(k.overallRag)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#5c7487;">Task Completion</td><td><strong>${k.taskCompletionPct}%</strong> (${k.completedTasks}/${k.totalTasks})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#5c7487;">Overdue</td><td>${k.overdueTaskCount}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#5c7487;">Blocked</td><td>${k.blockedTaskCount}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#5c7487;">Upcoming (7 days)</td><td>${k.upcomingMilestoneCount}</td></tr>
      </table>
      <p>${pdfBuffer ? "The full report is attached as a PDF." : "A PDF couldn't be attached this time — use the link below instead."}</p>
      <p><a href="${report.url}" style="color:#1d4e6d;">Open the live Slides deck</a></p>
    </div>
  `.trim();

  const raw = buildMimeMessage({
    to,
    subject: `${snapshot.name} — Client Status Report — ${today}`,
    htmlBody,
    attachment: pdfBuffer
      ? { filename: `${sanitizeFilename(snapshot.name)}-status-report.pdf`, mimeType: "application/pdf", data: pdfBuffer }
      : undefined,
  });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: toBase64Url(raw) },
  });
}

// ─────────────────────────── Daily task alerts ───────────────────────────
// Deliberately doesn't import anything from lib/alerts.ts (which is what
// calls sendTaskAlertEmail) — that would make the two files import each
// other. TaskAlertLine is a plain, local shape instead.

export interface TaskAlertLine {
  deliverableName: string;
  slotLabel: string;
  categoryLabel: string;
  effectiveDate: string;
  status: string;
}

export interface SendTaskAlertEmailOptions {
  accessToken: string;
  to: string;
  assignedToName: string;
  projectName: string;
  sheetUrl: string;
  lines: TaskAlertLine[];
}

/**
 * Sends one person's daily task-alert digest as the signed-in employee's
 * own Gmail — same "not a shared mailbox, new message only" model as
 * sendStatusReportEmail above. Called once per assignee per project per
 * day by the cron route (app/api/cron/daily-alerts); resends every day a
 * task is still flagged, by design — there's no per-task "already sent"
 * state to track.
 */
export async function sendTaskAlertEmail({
  accessToken,
  to,
  assignedToName,
  projectName,
  sheetUrl,
  lines,
}: SendTaskAlertEmailOptions): Promise<void> {
  if (lines.length === 0) return;

  const auth = buildAuthClient(accessToken);
  const gmail = google.gmail({ version: "v1", auth });

  const rows = lines
    .map(
      (l) => `
      <tr>
        <td style="padding:6px 12px 6px 0; border-bottom:1px solid #e5e5e5;">${escapeHtml(l.deliverableName)}</td>
        <td style="padding:6px 12px 6px 0; border-bottom:1px solid #e5e5e5;">${escapeHtml(l.slotLabel)}</td>
        <td style="padding:6px 12px 6px 0; border-bottom:1px solid #e5e5e5;">${escapeHtml(l.categoryLabel)}</td>
        <td style="padding:6px 12px 6px 0; border-bottom:1px solid #e5e5e5;">${escapeHtml(l.effectiveDate || "—")}</td>
        <td style="padding:6px 0 6px 0; border-bottom:1px solid #e5e5e5;">${escapeHtml(l.status || "—")}</td>
      </tr>`
    )
    .join("");

  const count = lines.length;
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; color: #1a1a1a; max-width: 640px;">
      <h2 style="color:#1d4e6d; margin-bottom: 4px;">${escapeHtml(projectName)}</h2>
      <p style="color:#5c7487; margin-top: 0;">Hi ${escapeHtml(assignedToName)} — you have ${count} task${count === 1 ? "" : "s"} needing attention today:</p>
      <table style="border-collapse: collapse; width:100%; font-size: 14px;">
        <tr style="text-align:left; color:#5c7487;">
          <th style="padding:0 12px 6px 0;">Deliverable</th>
          <th style="padding:0 12px 6px 0;">Task</th>
          <th style="padding:0 12px 6px 0;">Why</th>
          <th style="padding:0 12px 6px 0;">Date</th>
          <th style="padding:0;">Status</th>
        </tr>
        ${rows}
      </table>
      <p style="margin-top:16px;"><a href="${sheetUrl}" style="color:#1d4e6d;">Open the tracker</a></p>
      <p style="color:#9aa8b3; font-size:12px; margin-top: 24px;">
        You're getting this because your name is on this project's task list with an email on file on the Lists tab.
        This resends every day a task stays flagged — no action needed here beyond updating the tracker itself.
      </p>
    </div>
  `.trim();

  const raw = buildMimeMessage({
    to: [to],
    subject: `${projectName} — ${count} task${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your attention`,
    htmlBody,
  });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: toBase64Url(raw) },
  });
}
