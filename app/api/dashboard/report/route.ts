import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchProjectSnapshot, ProjectSnapshot } from "@/lib/dashboardData";
import { generateStatusReport, GeneratedReport } from "@/lib/statusReport";
import { postToGoogleChat } from "@/lib/googleChat";
import { sendStatusReportEmail, parseRecipients } from "@/lib/gmail";
import { extractSheetId } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const maxDuration = 90;

interface ChannelResult {
  attempted: boolean;
  ok: boolean;
  error?: string;
}

// POST /api/dashboard/report
// body: { sheetLink: string, chatWebhookUrl?: string, recipients?: string }
//
// Builds the Slides deck from the live sheet first — that part always runs.
// Chat and email are each best-effort on top of it: if a webhook URL or
// recipient list was given, we try that channel and report per-channel
// success/failure, but a failure in one never rolls back the deck or blocks
// the other channel. Whatever webhook/recipients were given get saved back
// onto the dashboard link so the panel is pre-filled next time.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken || !session.user?.email) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }
  if (session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Your Google session expired. Please sign out and back in." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.sheetLink !== "string" || !body.sheetLink.trim()) {
    return NextResponse.json({ error: "Missing the project's sheet link." }, { status: 400 });
  }

  const sheetId = extractSheetId(body.sheetLink);
  if (!sheetId) {
    return NextResponse.json({ error: "That doesn't look like a valid Google Sheets link." }, { status: 400 });
  }

  const chatWebhookUrl = typeof body.chatWebhookUrl === "string" ? body.chatWebhookUrl.trim() : "";
  const recipientsRaw = typeof body.recipients === "string" ? body.recipients.trim() : "";
  const recipients = parseRecipients(recipientsRaw);

  const accessToken = session.accessToken;

  // 1. Read the live sheet and build the deck. Any failure here is fatal —
  //    there's nothing to notify anyone about without it.
  let snapshot: ProjectSnapshot;
  try {
    snapshot = await fetchProjectSnapshot(accessToken, sheetId);
  } catch (err) {
    console.error(`Status report: could not read sheet ${sheetId}:`, err);
    return NextResponse.json({ error: "Could not read the project's tracker sheet. Is it still shared with you?" }, { status: 502 });
  }

  let report: GeneratedReport;
  try {
    report = await generateStatusReport(accessToken, snapshot);
  } catch (err) {
    console.error(`Status report: Slides generation failed for ${sheetId}:`, err);
    return NextResponse.json({ error: "Could not generate the Slides deck. Please try again." }, { status: 502 });
  }

  // 2. Best-effort notifications.
  const chat: ChannelResult = { attempted: Boolean(chatWebhookUrl), ok: false };
  if (chatWebhookUrl) {
    try {
      await postToGoogleChat(chatWebhookUrl, snapshot, report);
      chat.ok = true;
    } catch (err) {
      console.error(`Status report: Google Chat webhook failed for ${sheetId}:`, err);
      chat.error = err instanceof Error ? err.message : "Could not reach that Chat webhook.";
    }
  }

  const email: ChannelResult & { recipientCount: number } = {
    attempted: recipients.length > 0,
    ok: false,
    recipientCount: recipients.length,
  };
  if (recipients.length > 0) {
    try {
      await sendStatusReportEmail({ accessToken, to: recipients, snapshot, report });
      email.ok = true;
    } catch (err) {
      console.error(`Status report: Gmail send failed for ${sheetId}:`, err);
      const raw = err instanceof Error ? err.message : "";
      email.error = /insufficient|scope|403/i.test(raw)
        ? "Gmail access hasn't been granted yet — sign out and back in to allow sending, then try again."
        : "Could not send the email.";
    }
  } else if (recipientsRaw) {
    email.error = "None of the recipients entered looked like valid email addresses.";
  }

  // 3. Remember the webhook/recipients for next time (best-effort — doesn't
  //    affect the response either way).
  const { error: saveError } = await supabaseAdmin
    .from("dashboard_links")
    .update({
      chat_webhook_url: chatWebhookUrl || null,
      report_recipients: recipientsRaw || null,
    })
    .eq("user_email", session.user.email)
    .eq("sheet_id", sheetId);
  if (saveError) console.error(`Status report: could not save webhook/recipients for ${sheetId}:`, saveError);

  return NextResponse.json({
    slidesUrl: report.url,
    presentationId: report.presentationId,
    chat,
    email,
  });
}
