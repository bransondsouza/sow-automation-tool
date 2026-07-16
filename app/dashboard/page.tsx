"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import type { ProjectSnapshot, RollupKpis, ProjectFetchError, OverallRag, SchedulePace } from "@/lib/dashboardData";
import type { DashboardLink } from "@/lib/types";

function ragClass(rag: string): string {
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

function paceClass(pace: SchedulePace): string {
  switch (pace) {
    case "Behind":
      return "rag-red";
    case "On Pace":
      return "rag-green";
    case "Ahead":
      return "rag-amber";
    default:
      return "rag-notstarted";
  }
}

function RagBadge({ label }: { label: string }) {
  return <span className={`rag-badge ${ragClass(label)}`}>{label}</span>;
}

function KpiCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

const RAG_ORDER: OverallRag[] = ["Red", "Amber", "Gray", "Green", "Not Started"];

export default function DashboardPage() {
  const { data: session } = useSession();

  const [links, setLinks] = useState<DashboardLink[]>([]);
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [errors, setErrors] = useState<ProjectFetchError[]>([]);
  const [rollup, setRollup] = useState<RollupKpis | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submittingLink, setSubmittingLink] = useState(false);
  const [pullingBuHead, setPullingBuHead] = useState(false);

  const [addLinkValue, setAddLinkValue] = useState("");
  const [addLabelValue, setAddLabelValue] = useState("");
  const [buHeadValue, setBuHeadValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<string>("all");

  const linkIdBySheetId = useMemo(() => {
    const map = new Map<string, string>();
    links.forEach((l) => map.set(l.sheet_id, l.id));
    return map;
  }, [links]);

  async function loadAll(buHead?: string) {
    setRefreshing(true);
    setFormError(null);
    try {
      const query = buHead ? `?buHead=${encodeURIComponent(buHead)}` : "";
      const [linksRes, dataRes] = await Promise.all([
        fetch("/api/dashboard/links"),
        fetch(`/api/dashboard/data${query}`),
      ]);
      const linksBody = await linksRes.json();
      const dataBody = await dataRes.json();
      if (!linksRes.ok) throw new Error(linksBody.error || "Could not load your saved projects.");
      if (!dataRes.ok) throw new Error(dataBody.error || "Could not load project data.");

      setLinks(linksBody.links ?? []);
      setProjects(dataBody.projects ?? []);
      setErrors(dataBody.errors ?? []);
      setRollup(dataBody.rollup ?? null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unexpected error loading the dashboard.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAddLink(e: React.FormEvent) {
    e.preventDefault();
    if (!addLinkValue.trim()) {
      setFormError("Paste a Google Sheet link first.");
      return;
    }
    setSubmittingLink(true);
    setFormError(null);
    try {
      const res = await fetch("/api/dashboard/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetLink: addLinkValue.trim(), label: addLabelValue.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save that link.");
      setAddLinkValue("");
      setAddLabelValue("");
      await loadAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unexpected error adding that project.");
    } finally {
      setSubmittingLink(false);
    }
  }

  async function handlePullByBuHead(e: React.FormEvent) {
    e.preventDefault();
    if (!buHeadValue.trim()) {
      setFormError("Type a Business Unit Head's name or email first.");
      return;
    }
    setPullingBuHead(true);
    try {
      await loadAll(buHeadValue.trim());
    } finally {
      setPullingBuHead(false);
    }
  }

  async function handleRemove(sheetId: string) {
    const id = linkIdBySheetId.get(sheetId);
    if (!id) return;
    if (!confirm("Remove this project from your dashboard? The Google Sheet itself won't be touched.")) return;
    try {
      const res = await fetch(`/api/dashboard/links?id=${id}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not remove that project.");
      if (activeTab === sheetId) setActiveTab("all");
      await loadAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unexpected error removing that project.");
    }
  }

  const activeProject = projects.find((p) => p.sheetId === activeTab) ?? null;

  return (
    <main className="dashboard-shell">
      <div className="top-nav" style={{ maxWidth: "none", padding: 0, marginBottom: 24 }}>
        <span>Signed in as {session?.user?.email}</span>
        <Link href="/upload">← Back to Upload</Link>
      </div>

      <div className="card">
        <h1>Project Dashboard</h1>
        <p className="subtitle">
          Add tracker sheets by link, or pull in every project under a Business Unit Head. Everything
          you add here is saved to your account and read live from Google Sheets each time you open it.
        </p>

        <div className="dashboard-toolbar">
          <form onSubmit={handleAddLink} className="toolbar-form">
            <label htmlFor="addLinkValue">Add a project by sheet link</label>
            <div className="inline-form-row">
              <input
                id="addLinkValue"
                type="text"
                placeholder="Paste a Project Plan & Tracker sheet link"
                value={addLinkValue}
                onChange={(e) => setAddLinkValue(e.target.value)}
              />
            </div>
            <div className="inline-form-row" style={{ marginTop: 8 }}>
              <input
                type="text"
                placeholder="Label (optional)"
                value={addLabelValue}
                onChange={(e) => setAddLabelValue(e.target.value)}
              />
              <button type="submit" disabled={submittingLink} style={{ marginTop: 0 }}>
                {submittingLink ? "Adding…" : "Add"}
              </button>
            </div>
          </form>

          <form onSubmit={handlePullByBuHead} className="toolbar-form">
            <label htmlFor="buHeadValue">Pull all projects under a Business Unit Head</label>
            <div className="inline-form-row">
              <input
                id="buHeadValue"
                type="text"
                placeholder="Name or email, e.g. dana.ortiz@company.com"
                value={buHeadValue}
                onChange={(e) => setBuHeadValue(e.target.value)}
              />
              <button type="submit" disabled={pullingBuHead} style={{ marginTop: 0 }}>
                {pullingBuHead ? "Pulling…" : "Pull"}
              </button>
            </div>
            <p className="hint">
              Only finds sheets that were shared with you — auto-shared automatically if you're the BU
              Head named on the Upload form, otherwise ask the sheet owner to share it with you first.
            </p>
          </form>

          <div>
            <button type="button" onClick={() => loadAll()} disabled={refreshing} className="btn-secondary">
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {formError && <div className="error-box">{formError}</div>}

        {errors.length > 0 && (
          <div className="error-box">
            <strong>
              {errors.length} saved project{errors.length === 1 ? "" : "s"} couldn't be read:
            </strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              {errors.map((e) => (
                <li key={e.sheetId} style={{ marginTop: 4 }}>
                  {e.label || e.sheetId} — {e.error}{" "}
                  <button type="button" className="remove-link" onClick={() => handleRemove(e.sheetId)}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {loading ? (
        <div className="card">Loading your dashboard…</div>
      ) : (
        <>
          <div className="tab-bar">
            <button
              type="button"
              className={`tab-button ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All Projects{rollup ? ` (${rollup.projectCount})` : ""}
            </button>
            {projects.map((p) => (
              <button
                key={p.sheetId}
                type="button"
                className={`tab-button ${activeTab === p.sheetId ? "active" : ""}`}
                onClick={() => setActiveTab(p.sheetId)}
              >
                <span className={`tab-dot ${ragClass(p.kpis.overallRag)}`} />
                {p.name}
              </button>
            ))}
          </div>

          {projects.length === 0 && (
            <div className="card">
              <p className="subtitle" style={{ marginBottom: 0 }}>
                No projects on your dashboard yet — add a sheet link above, or pull everything under a
                Business Unit Head.
              </p>
            </div>
          )}

          {activeTab === "all" && rollup && projects.length > 0 && <RollupView rollup={rollup} projects={projects} onSelect={setActiveTab} />}

          {activeTab !== "all" && activeProject && (
            <ProjectView project={activeProject} onRemove={() => handleRemove(activeProject.sheetId)} />
          )}
        </>
      )}
    </main>
  );
}

function RollupView({
  rollup,
  projects,
  onSelect,
}: {
  rollup: RollupKpis;
  projects: ProjectSnapshot[];
  onSelect: (sheetId: string) => void;
}) {
  return (
    <div className="card">
      <h2>Portfolio Health</h2>
      <div className="kpi-grid">
        <KpiCard label="Active Projects" value={rollup.projectCount} />
        <KpiCard label="Avg. Task Completion" value={`${rollup.avgTaskCompletionPct}%`} />
        <KpiCard label="Overdue Tasks" value={rollup.totalOverdueTasks} />
        <KpiCard label="Blocked Tasks" value={rollup.totalBlockedTasks} />
        <KpiCard label="Upcoming Milestones" value={rollup.totalUpcomingMilestones} sub="Next 7 days" />
        <div className="kpi-card">
          <div className="kpi-label">RAG Breakdown</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {RAG_ORDER.filter((r) => rollup.ragCounts[r] > 0).map((r) => (
              <span key={r} className={`rag-badge ${ragClass(r)}`}>
                {r}: {rollup.ragCounts[r]}
              </span>
            ))}
          </div>
        </div>
      </div>

      <h2 style={{ marginTop: 32 }}>Projects</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>RAG</th>
            <th>Completion</th>
            <th>Overdue</th>
            <th>Days to Deadline</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.sheetId}>
              <td>
                <a href={p.sheetUrl} target="_blank" rel="noreferrer">
                  {p.name}
                </a>
              </td>
              <td>
                <RagBadge label={p.trackerGenerated ? p.kpis.overallRag : "Not Started"} />
              </td>
              <td>{p.trackerGenerated ? `${p.kpis.taskCompletionPct}%` : "—"}</td>
              <td>{p.trackerGenerated ? p.kpis.overdueTaskCount : "—"}</td>
              <td>{p.kpis.daysToDeadline ?? "—"}</td>
              <td>
                <button type="button" className="btn-secondary" onClick={() => onSelect(p.sheetId)} style={{ margin: 0 }}>
                  View →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rollup.resourceHours.length > 0 && (
        <>
          <h2 style={{ marginTop: 32 }}>Resource Load Across Projects</h2>
          <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
            Total hours allocated to each person across every project on this dashboard — a quick way to
            spot who's stretched thin.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Total Hours Allocated</th>
                <th>Projects</th>
              </tr>
            </thead>
            <tbody>
              {rollup.resourceHours.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{r.hours}</td>
                  <td>{r.projectCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ProjectView({ project, onRemove }: { project: ProjectSnapshot; onRemove: () => void }) {
  const k = project.kpis;

  return (
    <div className="card">
      <div className="project-header">
        <div>
          <h2 style={{ marginBottom: 4 }}>
            <a href={project.sheetUrl} target="_blank" rel="noreferrer">
              {project.name} →
            </a>
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {project.startDate || "No start date set"} → {project.endDate || "No end date set"}
            {project.buHead ? ` · BU Head: ${project.buHead}` : ""}
          </p>
        </div>
        <button type="button" className="remove-link" onClick={onRemove}>
          Remove from dashboard
        </button>
      </div>

      {!project.trackerGenerated ? (
        <p className="subtitle">
          The Project Tracking & Execution tab hasn't been generated yet. Open the sheet, fill in the
          Estimation & Resource Allocation tab, and click Project Tracker Tools ▸ Generate Project Tracker.
        </p>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Overall Health</div>
              <div className="kpi-value">
                <RagBadge label={k.overallRag} />
              </div>
            </div>
            <KpiCard label="Task Completion" value={`${k.taskCompletionPct}%`} sub={`${k.completedTasks} of ${k.totalTasks} tasks`} />
            <KpiCard label="On-Time Completion" value={k.onTimeCompletionPct !== null ? `${k.onTimeCompletionPct}%` : "—"} />
            <KpiCard label="Overdue Tasks" value={k.overdueTaskCount} />
            <KpiCard label="Blocked Tasks" value={k.blockedTaskCount} />
            <KpiCard label="Upcoming Milestones" value={k.upcomingMilestoneCount} sub="Next 7 days" />
            <KpiCard label="Days to Deadline" value={k.daysToDeadline ?? "—"} />
            <div className="kpi-card">
              <div className="kpi-label">Schedule Pace</div>
              <div className="kpi-value">
                <span className={`rag-badge ${paceClass(k.schedulePace)}`}>{k.schedulePace}</span>
              </div>
              {k.elapsedPct !== null && (
                <div className="kpi-sub">
                  {k.elapsedPct}% of time elapsed vs {k.taskCompletionPct}% of tasks complete
                </div>
              )}
            </div>
          </div>

          <h2 style={{ marginTop: 32 }}>Deliverables</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Deliverable</th>
                <th>RAG</th>
                <th>Current Stage</th>
                <th>Tasks Completed</th>
              </tr>
            </thead>
            <tbody>
              {project.deliverables.map((d) => (
                <tr key={d.name}>
                  <td>{d.name}</td>
                  <td>{d.rag ? <RagBadge label={d.rag} /> : "—"}</td>
                  <td>{d.currentStage || "—"}</td>
                  <td>
                    {d.tasks.filter((t) => t.completed).length} / {d.tasks.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {k.resourceHours.length > 0 && (
            <>
              <h2 style={{ marginTop: 32 }}>Resource Allocation</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Hours Allocated</th>
                  </tr>
                </thead>
                <tbody>
                  {k.resourceHours.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td>{r.hours}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
