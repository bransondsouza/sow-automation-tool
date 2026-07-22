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
