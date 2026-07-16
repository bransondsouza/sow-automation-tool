import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchProjectSnapshot, computeRollup, ProjectSnapshot, ProjectFetchError } from "@/lib/dashboardData";

export const runtime = "nodejs";
export const maxDuration = 90;

interface LinkEntry {
  sheet_id: string;
  sheet_url: string;
  label: string | null;
}

// GET /api/dashboard/data?buHead=<name or email>
//
// Loads every sheet this person has already saved to their dashboard, and —
// if a Business Unit Head was given — also looks up every completed job
// under that name/email and folds in any sheets not already saved (saving
// them for next time too, per "save permanently"). Then reads each sheet
// live with the viewer's own Google token and returns the computed KPIs.
export async function GET(req: NextRequest) {
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

  const accessToken = session.accessToken;
  const userEmail = session.user.email;
  const { searchParams } = new URL(req.url);
  const buHeadQuery = (searchParams.get("buHead") || "").trim();

  // 1. Start from this person's saved links.
  const { data: savedLinks, error: savedError } = await supabaseAdmin
    .from("dashboard_links")
    .select("sheet_id, sheet_url, label")
    .eq("user_email", userEmail);

  if (savedError) {
    console.error("Failed to load saved dashboard links:", savedError);
    return NextResponse.json({ error: "Could not load your saved projects." }, { status: 500 });
  }

  const linkMap = new Map<string, LinkEntry>();
  (savedLinks ?? []).forEach((l) => linkMap.set(l.sheet_id, l));

  // 2. If a BU Head was given, pull every completed job matching that
  //    name/email and save any newly-found ones so they persist next time.
  if (buHeadQuery) {
    const escaped = buHeadQuery.replace(/[%_]/g, (c) => `\\${c}`);
    const { data: buJobs, error: buError } = await supabaseAdmin
      .from("jobs")
      .select("sheet_id, sheet_url, sow_data, bu_head_name, bu_head_email")
      .eq("status", "complete")
      .not("sheet_id", "is", null)
      .or(`bu_head_email.ilike.%${escaped}%,bu_head_name.ilike.%${escaped}%`);

    if (buError) {
      console.error("Failed to look up jobs by BU Head:", buError);
    }

    const newLinks: { user_email: string; sheet_id: string; sheet_url: string; label: string | null; source: string }[] = [];
    (buJobs ?? []).forEach((j) => {
      if (!j.sheet_id || !j.sheet_url || linkMap.has(j.sheet_id)) return;
      const label = (j.sow_data as { projectName?: string } | null)?.projectName ?? null;
      linkMap.set(j.sheet_id, { sheet_id: j.sheet_id, sheet_url: j.sheet_url, label });
      newLinks.push({
        user_email: userEmail,
        sheet_id: j.sheet_id,
        sheet_url: j.sheet_url,
        label,
        source: "bu_head",
      });
    });

    if (newLinks.length > 0) {
      const { error: upsertError } = await supabaseAdmin
        .from("dashboard_links")
        .upsert(newLinks, { onConflict: "user_email,sheet_id" });
      if (upsertError) console.error("Failed to persist BU Head-discovered links:", upsertError);
    }
  }

  const entries = Array.from(linkMap.values());

  // 3. Read each sheet live. A single unreadable sheet (not shared with this
  //    viewer, moved, deleted) shouldn't take down the whole dashboard.
  const results = await Promise.all(
    entries.map(async (entry): Promise<{ ok: true; snapshot: ProjectSnapshot } | { ok: false; error: ProjectFetchError }> => {
      try {
        const snapshot = await fetchProjectSnapshot(accessToken, entry.sheet_id);
        return { ok: true, snapshot };
      } catch (err) {
        console.error(`Could not load dashboard sheet ${entry.sheet_id}:`, err);
        const raw = err instanceof Error ? err.message : "";
        const message = /permission|403|404|not found/i.test(raw)
          ? "Not shared with you, or the sheet was moved/deleted."
          : "Could not read this sheet right now.";
        return {
          ok: false,
          error: { sheetId: entry.sheet_id, sheetUrl: entry.sheet_url, label: entry.label, error: message },
        };
      }
    })
  );

  const projects = results.filter((r): r is { ok: true; snapshot: ProjectSnapshot } => r.ok).map((r) => r.snapshot);
  const errors = results.filter((r): r is { ok: false; error: ProjectFetchError } => !r.ok).map((r) => r.error);

  return NextResponse.json({ projects, errors, rollup: computeRollup(projects) });
}
