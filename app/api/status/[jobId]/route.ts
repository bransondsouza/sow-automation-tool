import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }

  const { data: job, error } = await supabaseAdmin
    .from("jobs")
    .select("*")
    .eq("id", params.jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  // Employees can only see the status of their own jobs.
  if (job.user_email !== session.user.email) {
    return NextResponse.json({ error: "Not authorized to view this job." }, { status: 403 });
  }

  return NextResponse.json(job);
}
