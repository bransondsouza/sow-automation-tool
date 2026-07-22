"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import type {
  ProjectSnapshot,
  RollupKpis,
  ProjectFetchError,
  OverallRag,
  SchedulePace,
  StatusCount,
  BurndownPoint,
} from "@/lib/dashboardData";
import type { DashboardLink } from "@/lib/types";
import ChartCanvas from "./ChartCanvas";
import DeliverableTimeline from "./DeliverableTimeline";
import DeliveryCalendar from "./DeliveryCalendar";

const RAG_COLORS: Record<string, string> = {
  Red: "#ef4444",
  Amber: "#f59e0b",
  Green: "#22c55e",
  Gray: "#9ca3af",
  "Not Started": "#cbd5e1",
};

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

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.startsWith("completed")) return "#22c55e";
  if (s.startsWith("blocked")) return "#ef4444";
  if (s.startsWith("wip")) return "#f59e0b";
  if (s.startsWith("on hold")) return "#9ca3af";
  if (s.startsWith("yts")) return "#cbd5e1";
  return "#94a3b8";
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

// ─────────────────────────── Chart data builders ───────────────────────────

function buildRagDonut(deliverables: { rag: string }[]) {
  const counts: Record<string, number> = {};
  deliverables.forEach((d) => {
    const key = d.rag || "Not Started";
    counts[key] = (counts[key] ?? 0) + 1;
  });
  const labels = Object.keys(counts);
  return {
    labels,
    datasets: [
      {
        data: labels.map((l) => counts[l]),
        backgroundColor: labels.map((l) => RAG_COLORS[l] ?? "#cbd5e1"),
        borderWidth: 0,
      },
    ],
  };
}

function buildPortfolioRagDonut(ragCounts: Record<OverallRag, number>) {
  const labels = RAG_ORDER.filter((r) => ragCounts[r] > 0);
  return {
    labels,
    datasets: [
      {
        data: labels.map((l) => ragCounts[l]),
        backgroundColor: labels.map((l) => RAG_COLORS[l] ?? "#cbd5e1"),
        borderWidth: 0,
      },
    ],
  };
}

function buildStatusBar(statusBreakdown: StatusCount[]) {
  return {
    labels: statusBreakdown.map((s) => s.status),
    datasets: [
      {
        label: "Tasks",
        data: statusBreakdown.map((s) => s.count),
        backgroundColor: statusBreakdown.map((s) => statusColor(s.status)),
        borderRadius: 4,
      },
    ],
  };
}

function buildBurndown(points: BurndownPoint[]) {
  return {
    labels: points.map((p) => p.date),
    datasets: [
      {
        label: "Ideal Pace",
        data: points.map((p) => p.idealPct),
        borderColor: "#94a3b8",
        borderDash: [6, 4],
        pointRadius: 0,
        borderWidth: 2,
        tension: 0,
        fill: false,
      },
      {
        label: "Actual",
        data: points.map((p) => p.actualPct),
        borderColor: "#1d4e6d",
        backgroundColor: "rgba(29,78,109,0.12)",
        pointRadius: 2,
        borderWidth: 2,
        tension: 0.2,
        fill: true,
      },
    ],
  };
}

function buildResourceBar(resourceHours: { name: string; hours: number }[]) {
  const top = resourceHours.slice(0, 10);
  return {
    labels: top.map((r) => r.name),
    datasets: [
      {
        label: "Hours Allocated",
        data: top.map((r) => r.hours),
        backgroundColor: "#1d4e6d",
        borderRadius: 4,
      },
    ],
  };
}

const horizontalBarOptions = {
  indexAxis: "y" as const,
  plugins: { legend: { display: false } },
  scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
};

const donutOptions = {
  plugins: { legend: { position: "bottom" as const } },
};

const burndownOptions = {
  plugins: { legend: { position: "bottom" as const } },
  scales: {
    y: {
      min: 0,
      max: 100,
      ticks: { callback: (v: string | number) => `${v}%` },
    },
  },
};

// Task-count-weighted RAG split — how many TASKS sit under a Red/Amber/
// Green/Gray deliverable, as opposed to how many DELIVERABLES are each
// color (that's what Deliverable Health / Portfolio RAG already show). A
// project with one huge Red deliverable and three tiny Green ones looks
// very different by task count than by deliverable count — this is the one
// that answers "how much of the actual work is at risk."
function buildTaskRagDonut(deliverables: { rag: string; tasks: unknown[] }[]) {
  const counts: Record<string, number> = {};
  deliverables.forEach((d) => {
    const key = d.rag || "Not Started";
    counts[key] = (counts[key] ?? 0) + d.tasks.length;
  });
  const labels = Object.keys(counts).filter((l) => counts[l] > 0);
  return {
    labels,
    datasets: [
      {
        data: labels.map((l) => counts[l]),
        backgroundColor: labels.map((l) => RAG_COLORS[l] ?? "#cbd5e1"),
        borderWidth: 0,
      },
    ],
  };
}

function taskRagTooltipLabel(ctx: { label?: string; parsed: number; dataset: { data: number[] } }): string {
  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
  const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
  return `${ctx.label ?? ""}: ${ctx.parsed} task${ctx.parsed === 1 ? "" : "s"} (${pct}%)`;
}

const taskRagDonutOptions = {
  plugins: {
    legend: { position: "bottom" as const },
    tooltip: { callbacks: { label: taskRagTooltipLabel } },
  },
};

// ─────────────────────── Click-to-filter (tasks) ───────────────────────

interface FlatTask {
  projectName: string;
  deliverableName: string;
  deliverableRag: string;
  taskLabel: string;
  assignedTo: string;
  status: string;
  baseline: string;
}

// Matches the exact grouping keys used elsewhere (computeKpis'
// statusBreakdown, buildTaskRagDonut) so a click always lines up 1:1 with
// what's shown in the chart that was clicked.
function flattenTasks(projects: ProjectSnapshot[]): FlatTask[] {
  const out: FlatTask[] = [];
  projects.forEach((p) => {
    p.deliverables.forEach((d) => {
      d.tasks.forEach((t) => {
        out.push({
          projectName: p.name,
          deliverableName: d.name,
          deliverableRag: d.rag || "Not Started",
          taskLabel: t.slotLabel,
          assignedTo: t.assignedTo,
          status: t.status || "Unknown",
          baseline: t.baseline,
        });
      });
    });
  });
  return out;
}

interface TaskFilters {
  status: string | null;
  user: string | null;
  rag: string | null;
}

const EMPTY_FILTERS: TaskFilters = { status: null, user: null, rag: null };

function TaskFilterPanel({
  projects,
  filters,
  onClear,
  showProject,
}: {
  projects: ProjectSnapshot[];
  filters: TaskFilters;
  onClear: (key: keyof TaskFilters) => void;
  showProject: boolean;
}) {
  const allTasks = useMemo(() => flattenTasks(projects), [projects]);

  if (!filters.status && !filters.user && !filters.rag) return null;

  const filtered = allTasks.filter((t) => {
    if (filters.status && t.status !== filters.status) return false;
    if (filters.user && t.assignedTo !== filters.user) return false;
    if (filters.rag && t.deliverableRag !== filters.rag) return false;
    return true;
  });

  return (
    <div className="filter-panel">
      <div className="filter-panel-header">
        <h3 style={{ margin: 0 }}>Filtered Tasks ({filtered.length})</h3>
        <div className="filter-chips">
          {filters.status && (
            <span className="filter-chip">
              Status: {filters.status}
              <button type="button" onClick={() => onClear("status")} aria-label="Clear status filter">
                ×
              </button>
            </span>
          )}
          {filters.user && (
            <span className="filter-chip">
              Assigned To: {filters.user}
              <button type="button" onClick={() => onClear("user")} aria-label="Clear assignee filter">
                ×
              </button>
            </span>
          )}
          {filters.rag && (
            <span className="filter-chip">
              RAG: {filters.rag}
              <button type="button" onClick={() => onClear("rag")} aria-label="Clear RAG filter">
                ×
              </button>
            </span>
          )}
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="hint">No tasks match this filter.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              {showProject && <th>Project</th>}
              <th>Deliverable</th>
              <th>Task</th>
              <th>Assigned To</th>
              <th>Status</th>
              <th>Baseline Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t, i) => (
              <tr key={i}>
                {showProject && <td>{t.projectName}</td>}
                <td>{t.deliverableName}</td>
                <td>{t.taskLabel}</td>
                <td>{t.assignedTo || "—"}</td>
                <td>{t.status || "—"}</td>
                <td>{t.baseline || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ────────────────────────────── Page ──────────────────────────────

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

  // The setup panel (add-link / pull-by-BU-head forms) auto-collapses the
  // first time the dashboard has data, so returning to it later shows just
  // the tabs and widgets — it stays reachable via "Manage Projects."
  const [manageOpen, setManageOpen] = useState(true);
  const autoCollapsedRef = useRef(false);

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

  useEffect(() => {
    if (!loading && projects.length > 0 && !autoCollapsedRef.current) {
      setManageOpen(false);
      autoCollapsedRef.current = true;
    }
  }, [loading, projects.length]);

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

      <div className="dashboard-header-row">
        <h1 style={{ marginBottom: 0 }}>Project Dashboard</h1>
        <button type="button" className="btn-secondary" onClick={() => setManageOpen((v) => !v)} style={{ margin: 0 }}>
          {manageOpen ? "Hide setup" : "+ Manage Projects"}
        </button>
      </div>

      {manageOpen && (
        <div className="card">
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
        </div>
      )}

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

          {activeTab === "all" && rollup && projects.length > 0 && (
            <RollupView rollup={rollup} projects={projects} onSelect={setActiveTab} />
          )}

          {activeTab !== "all" && activeProject && (
            <ProjectView
              key={activeProject.sheetId}
              project={activeProject}
              link={links.find((l) => l.sheet_id === activeProject.sheetId)}
              onRemove={() => handleRemove(activeProject.sheetId)}
            />
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
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);

  function setFilter(key: keyof TaskFilters, value: string) {
    setFilters((f) => ({ ...f, [key]: f[key] === value ? null : value }));
  }
  function clearFilter(key: keyof TaskFilters) {
    setFilters((f) => ({ ...f, [key]: null }));
  }

  const allDeliverables = useMemo(() => projects.flatMap((p) => p.deliverables), [projects]);

  return (
    <div className="card">
      <h2>Portfolio Health</h2>
      <div className="kpi-grid">
        <KpiCard label="Active Projects" value={rollup.projectCount} />
        <KpiCard label="Avg. Task Completion" value={`${rollup.avgTaskCompletionPct}%`} />
        <KpiCard label="Overdue Tasks" value={rollup.totalOverdueTasks} />
        <KpiCard label="Blocked Tasks" value={rollup.totalBlockedTasks} />
        <KpiCard label="Upcoming Milestones" value={rollup.totalUpcomingMilestones} sub="Next 7 days" />
      </div>

      <p className="hint" style={{ marginTop: 4 }}>
        Click a status bar, a name on the resource chart, or a slice of "Tasks by Health" below to filter
        the task list further down the page to just that.
      </p>

      <div className="chart-grid">
        <div className="chart-card">
          <h3>Portfolio RAG</h3>
          <ChartCanvas type="doughnut" data={buildPortfolioRagDonut(rollup.ragCounts)} options={donutOptions} height={220} />
        </div>
        <div className="chart-card">
          <h3>Tasks by Health (RAG)</h3>
          <ChartCanvas
            type="doughnut"
            data={buildTaskRagDonut(allDeliverables)}
            options={taskRagDonutOptions}
            height={220}
            onElementClick={(label) => setFilter("rag", label)}
          />
        </div>
        {rollup.statusBreakdown.length > 0 && (
          <div className="chart-card">
            <h3>Task Status Breakdown</h3>
            <ChartCanvas
              type="bar"
              data={buildStatusBar(rollup.statusBreakdown)}
              options={horizontalBarOptions}
              height={220}
              onElementClick={(label) => setFilter("status", label)}
            />
          </div>
        )}
        {rollup.resourceHours.length > 0 && (
          <div className="chart-card">
            <h3>Resource Load Across Projects</h3>
            <ChartCanvas
              type="bar"
              data={buildResourceBar(rollup.resourceHours)}
              options={horizontalBarOptions}
              height={Math.max(180, Math.min(rollup.resourceHours.length, 10) * 28)}
              onElementClick={(label) => setFilter("user", label)}
            />
          </div>
        )}
      </div>

      <TaskFilterPanel projects={projects} filters={filters} onClear={clearFilter} showProject />

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
            spot who's stretched thin. Click a row to filter the task list above to just their tasks.
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
                <tr key={r.name} className="clickable-row" onClick={() => setFilter("user", r.name)}>
                  <td>{r.name}</td>
                  <td>{r.hours}</td>
                  <td>{r.projectCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <DeliveryCalendar projects={projects} showProject />
    </div>
  );
}

function ProjectView({
  project,
  link,
  onRemove,
}: {
  project: ProjectSnapshot;
  link?: DashboardLink;
  onRemove: () => void;
}) {
  const k = project.kpis;
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);

  function setFilter(key: keyof TaskFilters, value: string) {
    setFilters((f) => ({ ...f, [key]: f[key] === value ? null : value }));
  }
  function clearFilter(key: keyof TaskFilters) {
    setFilters((f) => ({ ...f, [key]: null }));
  }

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

          <p className="hint">
            Click a status bar, a RAG slice, or a name on the resource chart to filter the task list below
            to just that.
          </p>

          <div className="chart-grid">
            <div className="chart-card">
              <h3>Deliverable Health</h3>
              <ChartCanvas
                type="doughnut"
                data={buildRagDonut(project.deliverables)}
                options={donutOptions}
                height={220}
                onElementClick={(label) => setFilter("rag", label)}
              />
            </div>
            <div className="chart-card">
              <h3>Tasks by Health (RAG)</h3>
              <ChartCanvas
                type="doughnut"
                data={buildTaskRagDonut(project.deliverables)}
                options={taskRagDonutOptions}
                height={220}
                onElementClick={(label) => setFilter("rag", label)}
              />
            </div>
            <div className="chart-card">
              <h3>Task Status Breakdown</h3>
              <ChartCanvas
                type="bar"
                data={buildStatusBar(k.statusBreakdown)}
                options={horizontalBarOptions}
                height={220}
                onElementClick={(label) => setFilter("status", label)}
              />
            </div>
            {k.burndown.length > 0 && (
              <div className="chart-card chart-card-wide">
                <h3>Burndown — Ideal Pace vs Actual</h3>
                <ChartCanvas type="line" data={buildBurndown(k.burndown)} options={burndownOptions} height={240} />
              </div>
            )}
            {k.resourceHours.length > 0 && (
              <div className="chart-card">
                <h3>Resource Allocation</h3>
                <ChartCanvas
                  type="bar"
                  data={buildResourceBar(k.resourceHours)}
                  options={horizontalBarOptions}
                  height={Math.max(180, k.resourceHours.length * 28)}
                  onElementClick={(label) => setFilter("user", label)}
                />
              </div>
            )}
          </div>

          <TaskFilterPanel projects={[project]} filters={filters} onClear={clearFilter} showProject={false} />

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

          <DeliverableTimeline project={project} />

          <DeliveryCalendar projects={[project]} />

          {k.resourceHours.length > 0 && (
            <>
              <h2 style={{ marginTop: 32 }}>Resource Allocation</h2>
              <p className="hint" style={{ marginTop: -8 }}>Click a row to filter the task list above to just their tasks.</p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Hours Allocated</th>
                  </tr>
                </thead>
                <tbody>
                  {k.resourceHours.map((r) => (
                    <tr key={r.name} className="clickable-row" onClick={() => setFilter("user", r.name)}>
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

      <StatusReportPanel project={project} link={link} />
    </div>
  );
}

function StatusReportPanel({ project, link }: { project: ProjectSnapshot; link?: DashboardLink }) {
  const [chatWebhookUrl, setChatWebhookUrl] = useState(link?.chat_webhook_url ?? "");
  const [recipients, setRecipients] = useState(link?.report_recipients ?? "");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    slidesUrl: string;
    chat: { attempted: boolean; ok: boolean; error?: string };
    email: { attempted: boolean; ok: boolean; error?: string; recipientCount: number };
  } | null>(null);

  // Reset the panel when the person switches to a different project's tab.
  useEffect(() => {
    setChatWebhookUrl(link?.chat_webhook_url ?? "");
    setRecipients(link?.report_recipients ?? "");
    setResult(null);
    setError(null);
  }, [link?.id, link?.chat_webhook_url, link?.report_recipients]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/dashboard/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetLink: project.sheetUrl,
          chatWebhookUrl: chatWebhookUrl.trim() || undefined,
          recipients: recipients.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not generate the report.");
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error generating the report.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="report-panel">
      <h2>Generate Client Status Report</h2>
      <p className="hint" style={{ marginTop: -8 }}>
        Builds a fresh Slides deck from this project's current numbers. Chat and email are both optional —
        fill in either, both, or neither and just get the deck.
      </p>

      <div className="inline-form-row" style={{ marginTop: 12, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="chatWebhookUrl">Google Chat webhook URL (optional)</label>
          <input
            id="chatWebhookUrl"
            type="text"
            placeholder="https://chat.googleapis.com/v1/spaces/.../messages?key=..."
            value={chatWebhookUrl}
            onChange={(e) => setChatWebhookUrl(e.target.value)}
          />
        </div>
      </div>
      <div className="inline-form-row" style={{ marginTop: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="reportRecipients">Email recipients (optional)</label>
          <input
            id="reportRecipients"
            type="text"
            placeholder="client@company.com, pm@company.com"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
        </div>
      </div>

      <button type="button" onClick={handleGenerate} disabled={generating} style={{ marginTop: 12 }}>
        {generating ? "Generating…" : "Generate Client Status Report"}
      </button>

      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {result && (
        <div className="report-result">
          <p>
            ✅ Deck ready —{" "}
            <a href={result.slidesUrl} target="_blank" rel="noreferrer">
              open in Google Slides
            </a>
          </p>
          {result.chat.attempted &&
            (result.chat.ok ? (
              <p className="hint">✅ Posted to Google Chat.</p>
            ) : (
              <div className="error-box">⚠️ Chat notification failed: {result.chat.error}</div>
            ))}
          {result.email.attempted &&
            (result.email.ok ? (
              <p className="hint">
                ✅ Emailed {result.email.recipientCount} recipient{result.email.recipientCount === 1 ? "" : "s"}.
              </p>
            ) : (
              <div className="error-box">⚠️ Email failed: {result.email.error}</div>
            ))}
        </div>
      )}
    </div>
  );
}
