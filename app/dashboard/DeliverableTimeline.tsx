"use client";

import type { DeliverableSnapshot, ProjectSnapshot } from "@/lib/dashboardData";

function ragBarClass(rag: string): string {
  switch (rag) {
    case "Red":
      return "rag-red";
    case "Amber":
      return "rag-amber";
    case "Green":
      return "rag-green";
    case "Gray":
      return "rag-gray";
    default:
      return "rag-notstarted";
  }
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function deliverableSpan(d: DeliverableSnapshot): { start: Date; end: Date } | null {
  const dates = d.tasks.map((t) => parseDate(t.baseline)).filter((x): x is Date => x !== null);
  if (dates.length === 0) return null;
  const start = new Date(Math.min(...dates.map((x) => x.getTime())));
  const end = new Date(Math.max(...dates.map((x) => x.getTime())));
  return { start, end };
}

/**
 * A lightweight, dependency-free Gantt-style strip: one row per deliverable,
 * a bar spanning its earliest-to-latest task Baseline Date, colored by RAG,
 * against a shared Project Start → Project End axis. A thin marker shows
 * today's position on every row (all rows share the same axis, so it lines
 * up as one continuous line).
 */
export default function DeliverableTimeline({ project }: { project: ProjectSnapshot }) {
  const projStart = parseDate(project.startDate);
  const projEnd = parseDate(project.endDate);

  if (!projStart || !projEnd || projEnd.getTime() <= projStart.getTime()) {
    return null;
  }

  const totalSpan = projEnd.getTime() - projStart.getTime();
  const rows = project.deliverables
    .map((d) => ({ deliverable: d, span: deliverableSpan(d) }))
    .filter((r): r is { deliverable: DeliverableSnapshot; span: { start: Date; end: Date } } => r.span !== null);

  if (rows.length === 0) return null;

  const todayPct = Math.min(100, Math.max(0, ((Date.now() - projStart.getTime()) / totalSpan) * 100));

  return (
    <div style={{ marginTop: 32 }}>
      <h2>Deliverable Timeline</h2>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        Each bar spans a deliverable's earliest to latest task Baseline Date, colored by RAG. The red
        marker is today.
      </p>
      <div className="timeline">
        {rows.map(({ deliverable, span }) => {
          const startPct = ((span.start.getTime() - projStart.getTime()) / totalSpan) * 100;
          const rawWidthPct = ((span.end.getTime() - span.start.getTime()) / totalSpan) * 100;
          const clampedLeft = Math.min(Math.max(startPct, 0), 100);
          const widthPct = Math.min(Math.max(rawWidthPct, 1.5), 100 - clampedLeft);
          return (
            <div className="timeline-row" key={deliverable.name}>
              <div className="timeline-label" title={deliverable.name}>
                {deliverable.name}
              </div>
              <div className="timeline-track">
                <div className="timeline-today-marker" style={{ left: `${todayPct}%` }} />
                <div
                  className={`timeline-bar ${ragBarClass(deliverable.rag)}`}
                  style={{ left: `${clampedLeft}%`, width: `${widthPct}%` }}
                  title={`${deliverable.name}: ${span.start.toISOString().slice(0, 10)} → ${span.end
                    .toISOString()
                    .slice(0, 10)} · ${deliverable.rag || "Not Started"}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
