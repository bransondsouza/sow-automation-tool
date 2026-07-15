"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type JobStatus =
  | "extracting"
  | "parsing"
  | "generating_slides"
  | "generating_sheet"
  | "finalizing"
  | "complete"
  | "error";

interface Job {
  id: string;
  status: JobStatus;
  original_filename: string;
  slides_url: string | null;
  sheet_url: string | null;
  bu_head_email: string | null;
  script_error: string | null;
  error_message: string | null;
}

const STEPS: { key: JobStatus; label: string }[] = [
  { key: "extracting", label: "Reading the document" },
  { key: "parsing", label: "Extracting project details with AI" },
  { key: "generating_slides", label: "Building your Slides deck" },
  { key: "generating_sheet", label: "Building your project tracker" },
  { key: "finalizing", label: "Installing the tracker button + sharing" },
  { key: "complete", label: "Done" },
];

function stepState(current: JobStatus, step: JobStatus): "pending" | "active" | "done" {
  const order = STEPS.map((s) => s.key);
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(step);
  if (current === "error") return stepIndex === 0 ? "active" : "pending";
  if (stepIndex < currentIndex) return "done";
  if (stepIndex === currentIndex) return "active";
  return "pending";
}

export default function StatusPage() {
  const params = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/status/${params.jobId}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Could not load job status.");
        if (!cancelled) setJob(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unexpected error.");
      }
    }

    poll();
    const interval = setInterval(() => {
      if (!job || (job.status !== "complete" && job.status !== "error")) {
        poll();
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.jobId, job?.status]);

  return (
    <main>
      <div className="card">
        <h1>Generating your deliverables</h1>
        <p className="subtitle">{job?.original_filename ?? "Loading…"}</p>

        {error && <div className="error-box">{error}</div>}

        {job && job.status !== "error" && (
          <div>
            {STEPS.map((step) => {
              const state = stepState(job.status, step.key);
              return (
                <div className="status-row" key={step.key}>
                  <span className={`dot ${state === "active" ? "active" : ""} ${state === "done" ? "done" : ""}`} />
                  <span>{step.label}</span>
                </div>
              );
            })}
          </div>
        )}

        {job?.status === "complete" && (
          <div className="success-box">
            <p>
              <strong>Your pitch deck and project tracker are ready.</strong>
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {job.slides_url && (
                <a className="btn" href={job.slides_url} target="_blank" rel="noreferrer">
                  Open Pitch Deck →
                </a>
              )}
              {job.sheet_url && (
                <a className="btn" href={job.sheet_url} target="_blank" rel="noreferrer" style={{ background: "#16a34a" }}>
                  Open Project Tracker →
                </a>
              )}
            </div>
            {job.bu_head_email && (
              <p className="hint" style={{ marginTop: 12 }}>
                Shared with {job.bu_head_email}.
              </p>
            )}
            {job.script_error && (
              <div className="error-box" style={{ marginTop: 12 }}>
                {job.script_error}
              </div>
            )}
          </div>
        )}

        {job?.status === "error" && (
          <div className="error-box">
            <strong>Something went wrong:</strong> {job.error_message}
          </div>
        )}
      </div>
    </main>
  );
}
