"use client";

import { useMemo, useState } from "react";
import type { ProjectSnapshot } from "@/lib/dashboardData";

interface CalendarEvent {
  date: string; // yyyy-mm-dd
  projectName: string;
  deliverableName: string;
  taskLabel: string;
  status: string;
  assignedTo: string;
  completed: boolean;
  blocked: boolean;
  overdue: boolean;
}

function flattenEvents(projects: ProjectSnapshot[]): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  projects.forEach((p) => {
    p.deliverables.forEach((d) => {
      d.tasks.forEach((t) => {
        if (!t.baseline) return;
        events.push({
          date: t.baseline,
          projectName: p.name,
          deliverableName: d.name,
          taskLabel: t.slotLabel,
          status: t.status || "YTS",
          assignedTo: t.assignedTo,
          completed: t.completed,
          blocked: t.blocked,
          overdue: t.overdue,
        });
      });
    });
  });
  return events;
}

function dayColor(dayEvents: CalendarEvent[]): string {
  if (dayEvents.some((e) => e.blocked || e.overdue)) return "#ef4444";
  if (dayEvents.every((e) => e.completed)) return "#22c55e";
  if (dayEvents.some((e) => !/^yts/i.test(e.status))) return "#f59e0b";
  return "#1d4e6d";
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function formatMonthLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export default function DeliveryCalendar({
  projects,
  showProject = false,
}: {
  projects: ProjectSnapshot[];
  showProject?: boolean;
}) {
  const allEvents = useMemo(() => flattenEvents(projects), [projects]);

  const stageOptions = useMemo(() => {
    const set = new Set<string>();
    allEvents.forEach((e) => set.add(e.taskLabel));
    return Array.from(set).sort();
  }, [allEvents]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [stageFilter, setStageFilter] = useState("All");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const base = allEvents[0]?.date;
    const d = base ? new Date(base) : new Date();
    return isNaN(d.getTime()) ? new Date() : new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const filteredEvents = useMemo(() => {
    return allEvents.filter((e) => {
      if (dateFrom && e.date < dateFrom) return false;
      if (dateTo && e.date > dateTo) return false;
      if (stageFilter !== "All" && e.taskLabel !== stageFilter) return false;
      return true;
    });
  }, [allEvents, dateFrom, dateTo, stageFilter]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    filteredEvents.forEach((e) => {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    });
    return map;
  }, [filteredEvents]);

  const delayPct =
    filteredEvents.length > 0
      ? Math.round((filteredEvents.filter((e) => e.overdue).length / filteredEvents.length) * 100)
      : 0;

  const busiest = useMemo(() => {
    let best: { date: string; count: number } | null = null;
    eventsByDate.forEach((list, date) => {
      if (!best || list.length > best.count) best = { date, count: list.length };
    });
    return best;
  }, [eventsByDate]);

  function shiftMonth(delta: number) {
    setViewMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }

  function resetFilters() {
    setDateFrom("");
    setDateTo("");
    setStageFilter("All");
  }

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const selectedEvents = selectedDate ? eventsByDate.get(selectedDate) ?? [] : [];
  const filtersActive = Boolean(dateFrom || dateTo || stageFilter !== "All");

  return (
    <div style={{ marginTop: 32 }}>
      <h2>Delivery Calendar</h2>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        Each date shows how many tasks have a Baseline Date that day. Click a date to see what's due.
      </p>

      <div className="calendar-filters">
        <div>
          <label htmlFor="calFrom">From</label>
          <input id="calFrom" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="calTo">To</label>
          <input id="calTo" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="calStage">Stage / Task Type</label>
          <select id="calStage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="All">All stages</option>
            {stageOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {filtersActive && (
          <button type="button" className="btn-secondary" onClick={resetFilters} style={{ marginTop: 0 }}>
            Reset filters
          </button>
        )}
      </div>

      <div className="kpi-grid" style={{ marginTop: 16 }}>
        <div className="kpi-card">
          <div className="kpi-label">Delay %</div>
          <div className="kpi-value">{delayPct}%</div>
          <div className="kpi-sub">
            {filteredEvents.filter((e) => e.overdue).length} of {filteredEvents.length} tasks overdue
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Busiest Day</div>
          <div className="kpi-value">{busiest ? busiest.count : "—"}</div>
          <div className="kpi-sub">{busiest ? busiest.date : "No deliveries in range"}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">In Range</div>
          <div className="kpi-value">{filteredEvents.length}</div>
          <div className="kpi-sub">task deliveries</div>
        </div>
      </div>

      <div className="calendar-widget">
        <div className="calendar-header">
          <button type="button" className="btn-secondary" onClick={() => shiftMonth(-1)} style={{ margin: 0 }}>
            ←
          </button>
          <strong>{formatMonthLabel(viewMonth)}</strong>
          <button type="button" className="btn-secondary" onClick={() => shiftMonth(1)} style={{ margin: 0 }}>
            →
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1))}
            style={{ margin: 0 }}
          >
            Today
          </button>
        </div>
        <div className="calendar-grid calendar-weekdays">
          {WEEKDAYS.map((w, i) => (
            <div key={i} className="calendar-weekday">
              {w}
            </div>
          ))}
        </div>
        <div className="calendar-grid">
          {cells.map((d, idx) => {
            if (d === null) return <div key={idx} className="calendar-cell calendar-cell-empty" />;
            const key = toKey(year, month, d);
            const dayEvents = eventsByDate.get(key) ?? [];
            const isToday = key === todayKey;
            const isSelected = key === selectedDate;
            return (
              <button
                type="button"
                key={idx}
                className={`calendar-cell ${isToday ? "calendar-cell-today" : ""} ${isSelected ? "calendar-cell-selected" : ""}`}
                onClick={() => dayEvents.length > 0 && setSelectedDate(isSelected ? null : key)}
                disabled={dayEvents.length === 0}
                title={dayEvents.length > 0 ? `${dayEvents.length} due ${key}` : key}
              >
                <span className="calendar-date-num">{d}</span>
                {dayEvents.length > 0 && (
                  <span className="calendar-count-badge" style={{ background: dayColor(dayEvents) }}>
                    {dayEvents.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="calendar-detail">
          <h3>
            Due {selectedDate} ({selectedEvents.length})
          </h3>
          {selectedEvents.length === 0 ? (
            <p className="hint">Nothing due this day.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  {showProject && <th>Project</th>}
                  <th>Deliverable</th>
                  <th>Task</th>
                  <th>Assigned To</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedEvents.map((e, i) => (
                  <tr key={i}>
                    {showProject && <td>{e.projectName}</td>}
                    <td>{e.deliverableName}</td>
                    <td>{e.taskLabel}</td>
                    <td>{e.assignedTo || "—"}</td>
                    <td>{e.status || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
