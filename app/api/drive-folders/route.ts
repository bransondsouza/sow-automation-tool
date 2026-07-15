import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { createDriveFolders } from "@/lib/googleDrive";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Please sign in with Google first." }, { status: 401 });
  }
  if (session.error === "RefreshAccessTokenError") {
    return NextResponse.json(
      { error: "Your Google session expired. Please sign out and back in." },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.parentFolder !== "string" || !Array.isArray(body.folderNames)) {
    return NextResponse.json({ error: "Missing parentFolder or folderNames." }, { status: 400 });
  }

  try {
    const folders = await createDriveFolders(session.accessToken, body.parentFolder, body.folderNames);
    return NextResponse.json({ folders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error creating folders.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
