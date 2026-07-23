import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStoredRefreshToken, exchangeRefreshToken } from "@/lib/tokenStore";
import { runProjectAlerts, ProjectAlertResult } from "@/lib/alerts";

export const runtime = "nodejs";
export const maxDuration = 300;

// GET /api/cron/daily-alerts
//
// Triggered by Vercel Cron (see vercel.json's "crons" entry) once a day.
// Not meant to be called by hand or from the browser — protected by
// CRON_SECRET, which Vercel automatically sends as
// "Authorization: Bearer <CRON_SECRET>" on cron-triggered requests. See
// DASHBOARD.md's "Daily Task Alerts" section for the full design and the
// scope decisions behind it (daily re-alert, per-project Chat digest not
// per-person DM, "due today" = Plan Date if set else Baseline Date).
//
// Every project on anyone's dashboard gets checked once, not once per
// person who added it: dashboard_links is grouped by sheet_id first. To
// actually read a sheet and send email as someone, this needs an encrypted
// refresh token on file for at least one of the people who linked it (see
// lib/tokenStore.ts) — that's whoever most recently signed in after this
// feature shipped. If nobody who linked a given sheet has signed in since,
// that one project is skipped (reported as an error in the summary) rather
// than failing the whole run.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { data: links, error } = await supabaseAdmin
    .from("dashboard_links")
    .select("user_email, sheet_id, chat_webhook_url");

  if (error) {
    console.error("Daily alerts: could not read dashboard_links:", error);
    return NextResponse.json({ error: "Could not read dashboard links." }, { status: 500 });
  }

  // Group by sheet_id: every viewer who linked this sheet is a candidate
  // for "whose stored token do we read/send as," and the first non-empty
  // chat_webhook_url among them is the one Chat digest this project gets.
  interface ProjectGroup {
    sheetId: string;
    candidateEmails: string[];
    chatWebhookUrl: string | null;
  }
  const groups = new Map<string, ProjectGroup>();
  (links ?? []).forEach((row) => {
    const sheetId = row.sheet_id as string;
    const group = groups.get(sheetId) ?? { sheetId, candidateEmails: [], chatWebhookUrl: null };
    if (row.user_email && !group.candidateEmails.includes(row.user_email)) {
      group.candidateEmails.push(row.user_email as string);
    }
    if (!group.chatWebhookUrl && row.chat_webhook_url) {
      group.chatWebhookUrl = row.chat_webhook_url as string;
    }
    groups.set(sheetId, group);
  });

  const results: ProjectAlertResult[] = [];
  const skipped: { sheetId: string; reason: string }[] = [];

  for (const group of groups.values()) {
    let accessToken: string | null = null;
    let lastError = "";

    for (const email of group.candidateEmails) {
      try {
        const refreshToken = await getStoredRefreshToken(email);
        if (!refreshToken) continue;
        const exchanged = await exchangeRefreshToken(refreshToken);
        accessToken = exchanged.accessToken;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Could not refresh this person's Google token.";
      }
    }

    if (!accessToken) {
      skipped.push({
        sheetId: group.sheetId,
        reason: lastError || "Nobody who linked this project has a Google sign-in on file yet.",
      });
      continue;
    }

    const result = await runProjectAlerts(accessToken, group.sheetId, group.chatWebhookUrl);
    results.push(result);
  }

  const totals = results.reduce(
    (acc, r) => {
      acc.totalFlagged += r.totalFlagged;
      acc.emailsSent += r.emailsSent;
      acc.emailsFailed += r.emailsFailed;
      return acc;
    },
    { totalFlagged: 0, emailsSent: 0, emailsFailed: 0 }
  );

  return NextResponse.json({
    projectsChecked: results.length,
    projectsSkipped: skipped.length,
    ...totals,
    results,
    skipped,
  });
}
