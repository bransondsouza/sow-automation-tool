import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { supabaseAdmin, STORAGE_BUCKET } from "@/lib/supabase";
import { extractTextFromFile } from "@/lib/parseDocument";
import { extractSOWData } from "@/lib/claude";
import { generateSlideDeck, extractFileId } from "@/lib/googleSlides";
import { generateProjectSheet } from "@/lib/googleSheets";
import { attachTrackerScript } from "@/lib/googleAppsScript";
import { shareFileWithEmail } from "@/lib/googleDrive";

export const runtime = "nodejs";
export const maxDuration = 300; // seconds — requires a Vercel plan that allows it; see deployment guide

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken || !session.user?.email) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }
  if (session.error === "RefreshAccessTokenError") {
    return NextResponse.json(
      { error: "Your Google session expired. Please sign out and back in." },
      { status: 401 }
    );
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const templateInput = (formData.get("templateId") as string | null) || "";
  const rosterInput = (formData.get("teamRoster") as string | null) || "";
  const teamRoster = rosterInput
    .split(/[,\n]/)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const buHeadName = ((formData.get("buHeadName") as string | null) || "").trim();
  const buHeadEmail = ((formData.get("buHeadEmail") as string | null) || "").trim();
  // Email is the key used for sharing + dashboard lookups; name is just a label.
  const buHead = buHeadEmail ? { name: buHeadName || buHeadEmail, email: buHeadEmail } : undefined;

  if (!file) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "File is too large (15MB max)." }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type) && !/\.(pdf|docx)$/i.test(file.name)) {
    return NextResponse.json(
      { error: "Unsupported file type. Please upload a PDF or .docx file." },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 1. Create the job row so the UI has something to poll immediately.
  const { data: job, error: insertError } = await supabaseAdmin
    .from("jobs")
    .insert({
      user_email: session.user.email,
      status: "extracting",
      original_filename: file.name,
      bu_head_name: buHead?.name ?? null,
      bu_head_email: buHead?.email ?? null,
    })
    .select()
    .single();

  if (insertError || !job) {
    console.error("Failed to create job row:", insertError);
    return NextResponse.json({ error: "Could not start the job. Please try again." }, { status: 500 });
  }

  const jobId = job.id as string;

  // Everything below updates the same job row as it progresses. Errors at
  // any step mark the job 'error' with a human-readable message rather than
  // throwing a raw 500, since the employee is watching the status page.
  try {
    // Keep a copy of the original upload for audit purposes.
    await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(`${jobId}/${file.name}`, buffer, { contentType: file.type, upsert: true });

    const sowText = await extractTextFromFile(buffer, file.type, file.name);

    await supabaseAdmin.from("jobs").update({ status: "parsing" }).eq("id", jobId);
    const sowData = await extractSOWData(sowText);

    await supabaseAdmin
      .from("jobs")
      .update({ status: "generating_slides", sow_data: sowData })
      .eq("id", jobId);

    const templateId = templateInput
      ? extractFileId(templateInput)
      : process.env.DEFAULT_TEMPLATE_ID;

    if (!templateId) {
      throw new Error(
        "No Slides template is configured. Set DEFAULT_TEMPLATE_ID in your environment variables, or paste a template link."
      );
    }

    const deck = await generateSlideDeck(session.accessToken, templateId, sowData);

    await supabaseAdmin
      .from("jobs")
      .update({ status: "generating_sheet", slides_url: deck.url, template_id: templateId })
      .eq("id", jobId);

    const sheet = await generateProjectSheet(session.accessToken, sowData, teamRoster, buHead);

    await supabaseAdmin
      .from("jobs")
      .update({ status: "finalizing", sheet_url: sheet.url, sheet_id: sheet.spreadsheetId })
      .eq("id", jobId);

    // Both of these are nice-to-haves layered on top of an already-useful
    // spreadsheet — a failure here (missing Apps Script API setup, an
    // invalid BU Head email, etc.) shouldn't fail the whole job.
    let scriptError: string | null = null;
    try {
      await attachTrackerScript(session.accessToken, sheet.spreadsheetId);
    } catch (err) {
      console.error("Could not attach the tracker script:", err);
      scriptError =
        "The in-sheet 'Generate Project Tracker' button couldn't be installed automatically (see SHEETS_TRACKER.md for the manual fallback and common causes).";
    }

    if (buHead?.email) {
      try {
        await shareFileWithEmail(session.accessToken, sheet.spreadsheetId, buHead.email, "reader");
      } catch (err) {
        console.error("Could not share the sheet with the BU Head:", err);
      }
    }

    await supabaseAdmin
      .from("jobs")
      .update({ status: "complete", script_error: scriptError })
      .eq("id", jobId);
  } catch (err) {
    console.error("Job failed:", err);
    const message = err instanceof Error ? err.message : "Unexpected error while processing the SOW.";
    await supabaseAdmin.from("jobs").update({ status: "error", error_message: message }).eq("id", jobId);
  }

  return NextResponse.json({ jobId });
}
