import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { supabaseAdmin } from "@/lib/supabase";
import { extractSheetId } from "@/lib/googleSheets";

export const runtime = "nodejs";

// GET — list this person's saved dashboard links.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("dashboard_links")
    .select("*")
    .eq("user_email", session.user.email)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to load dashboard links:", error);
    return NextResponse.json({ error: "Could not load your saved projects." }, { status: 500 });
  }

  return NextResponse.json({ links: data ?? [] });
}

// POST — save (or update the label of) a pasted sheet link.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.sheetLink !== "string" || !body.sheetLink.trim()) {
    return NextResponse.json({ error: "Please paste a Google Sheet link." }, { status: 400 });
  }

  const sheetId = extractSheetId(body.sheetLink);
  if (!sheetId) {
    return NextResponse.json({ error: "That doesn't look like a valid Google Sheets link." }, { status: 400 });
  }
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;

  const { data, error } = await supabaseAdmin
    .from("dashboard_links")
    .upsert(
      {
        user_email: session.user.email,
        sheet_id: sheetId,
        sheet_url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
        label,
        source: "manual",
      },
      { onConflict: "user_email,sheet_id" }
    )
    .select()
    .single();

  if (error) {
    console.error("Failed to save dashboard link:", error);
    return NextResponse.json({ error: "Could not save that link." }, { status: 500 });
  }

  return NextResponse.json({ link: data });
}

// DELETE — remove a saved link (?id=...).
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("dashboard_links")
    .delete()
    .eq("id", id)
    .eq("user_email", session.user.email);

  if (error) {
    console.error("Failed to remove dashboard link:", error);
    return NextResponse.json({ error: "Could not remove that link." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
