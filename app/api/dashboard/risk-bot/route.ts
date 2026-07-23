import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { fetchProjectSnapshot } from "@/lib/dashboardData";
import { extractSheetId } from "@/lib/googleSheets";
import { askRiskBot, buildRiskContext, ANALYZE_RISKS_PROMPT, ChatTurn } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RawChatTurn {
  role?: unknown;
  text?: unknown;
}

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawChatTurn[])
    .filter((t): t is RawChatTurn => !!t && typeof t === "object")
    .filter((t) => typeof t.text === "string" && t.text.trim() !== "")
    .map((t) => ({ role: t.role === "user" ? "user" : "bot", text: String(t.text) }));
}

// POST /api/dashboard/risk-bot
// body: { sheetLink: string, message?: string, history?: {role, text}[], initial?: boolean }
//
// Re-reads the live tracker sheet with the signed-in user's own token —
// same live-read pattern as every other dashboard route — so this needs no
// stored credentials; it only ever runs while someone is actively looking
// at the dashboard. Context is rebuilt fresh on every call (not cached
// across turns) since project status can change mid-conversation.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken || !session.user?.email) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }
  if (session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Your Google session expired. Please sign out and back in." }, { status: 401 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "The risk assistant isn't configured yet (missing GEMINI_API_KEY)." }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.sheetLink !== "string" || !body.sheetLink.trim()) {
    return NextResponse.json({ error: "Missing the project's sheet link." }, { status: 400 });
  }

  const sheetId = extractSheetId(body.sheetLink);
  if (!sheetId) {
    return NextResponse.json({ error: "That doesn't look like a valid Google Sheets link." }, { status: 400 });
  }

  const initial = body.initial === true;
  const message = initial ? ANALYZE_RISKS_PROMPT : typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "Type a message first." }, { status: 400 });
  }

  const history = parseHistory(body.history);

  let snapshot;
  try {
    snapshot = await fetchProjectSnapshot(session.accessToken, sheetId);
  } catch (err) {
    console.error(`Risk bot: could not read sheet ${sheetId}:`, err);
    return NextResponse.json({ error: "Could not read the project's tracker sheet. Is it still shared with you?" }, { status: 502 });
  }

  const context = buildRiskContext(snapshot);

  try {
    const reply = await askRiskBot(context, history, message);
    return NextResponse.json({ reply });
  } catch (err) {
    console.error(`Risk bot: Gemini call failed for ${sheetId}:`, err);
    const raw = err instanceof Error ? err.message : "";
    return NextResponse.json({ error: raw || "The risk assistant couldn't respond. Please try again." }, { status: 502 });
  }
}
