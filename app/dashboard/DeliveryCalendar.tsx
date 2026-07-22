"use client";

import { useMemo, useState } from "react";
import type { ProjectSnapshot } from "@/lib/dashboardData";
import MonthlyBreakdown from "./MonthlyBreakdown";
import { stageColor } from "./stageColors";

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

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

// yyyy-mm-dd -> a local-time Date. `new Date("yyyy-mm-dd")` parses as UTC
// midnight per the ECMA-262 spec, which shifts a day when later read back
// with local getters (getFullYear/getMonth) in timezones behind UTC —
// exactly the kind of off-by-one that would page the calendar to the wrong
// month. Parsing the parts by hand keeps everything in local time.
function parseLocalDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return isNaN(date.getTime()) ? null : date;
}

function monthLabel(y: number, m: number): string {
  return new Date(y, m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function dominantStage(dayEvents: CalendarEvent[]): string {
  const counts = new Map<string, number>();
  dayEvents.forEach((e) => counts.set(e.taskLabel, (counts.get(e.taskLabel) ?? 0) + 1));
  let best = dayEvents[0].taskLabel;
  let bestCount = 0;
  counts.forEach((c, name) => {
    if (c > bestCount) {
      bestCount = c;
      best = name;
    }
  });
  return best;
}

function stageMix(dayEvents: CalendarEvent[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  dayEvents.forEach((e) => counts.set(e.taskLabel, (counts.get(e.taskLabel) ?? 0) + 1));
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS_PER_PAGE = 3;

export default function DeliveryCalendar({
  projects,
  showProject = false,
}: {
  projects: ProjectSnapshot[];
  showProject?: boolean;
}) {
  const allEvents = useMemo(() => flattenEvents(projects), [projects]);

  // Stage order (first-seen, across every event regardless of filters) so a
  // given stage always gets the same color here and on the By Month widget,
  // no matter what date range or stage filter is active.
  const stageOrder = useMemo(() => {
    const order: string[] = [];
    allEvents.forEach((e) => {
      if (!order.includes(e.taskLabel)) order.push(e.taskLabel);
    });
    return order;
  }, [allEvents]);

  const stageOptions = useMemo(() => [...stageOrder].sort(), [stageOrder]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [stageFilter, setStageFilter] = useState("All");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const [pageStart, setPageStart] = useState<Date>(() => {
    const dates = allEvents.map((e) => e.date).sort();
    const base = dates[0];
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

  // Date-range only (no stage filter) — feeds the monthly stage-mix
  // breakdown, which exists specifically to show the stage mix, so pinning
  // it to a single stage would defeat its purpose.
  const dateRangeEvents = useMemo(() => {
    return allEvents.filter((e) => {
      if (dateFrom && e.date < dateFrom) return false;
      if (dateTo && e.date > dateTo) return false;
      return true;
    });
  }, [allEvents, dateFrom, dateTo]);

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

  const busiest = useMemo<{ date: string; count: number } | null>(() => {
    return Array.from(eventsByDate.entries()).reduce<{ date: string; count: number } | null>(
      (best, [date, list]) => (list.length > (best?.count ?? 0) ? { date, count: list.length } : best),
      null
    );
  }, [eventsByDate]);

  function shiftPage(delta: number) {
    setPageStart((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta * MONTHS_PER_PAGE, 1));
  }

  function jumpToToday() {
    const now = new Date();
    setPageStart(new Date(now.getFullYear(), now.getMonth(), 1));
  }

  // Clicking the Busiest Day KPI acts like clicking that date on the
  // calendar itself — selects it (showing its task list below), and pages
  // the calendar over to its month first if it isn't currently in view.
  function jumpToBusiest() {
    if (!busiest) return;
    const d = parseLocalDateKey(busiest.date);
    if (!d) return;
    const monthsFromPageStart = (d.getFullYear() - pageStart.getFullYear()) * 12 + (d.getMonth() - pageStart.getMonth());
    if (monthsFromPageStart < 0 || monthsFromPageStart >= MONTHS_PER_PAGE) {
      setPageStart(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setSelectedDate((prev) => (prev === busiest.date ? null : busiest.date));
  }

  function resetFilters() {
    setDateFrom("");
    setDateTo("");
    setStageFilter("All");
  }

  const now = new Date();
  const todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());
  const filtersActive = Boolean(dateFrom || dateTo || stageFilter !== "All");

  const pageMonths = Array.from({ length: MONTHS_PER_PAGE }, (_, i) => {
    const d = new Date(pageStart.getFullYear(), pageStart.getMonth() + i, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const selectedEvents = selectedDate ? eventsByDate.get(selectedDate) ?? [] : [];

  return (
    <div style={{ marginTop: 32 }}>
      <h2>Delivery Calendar</h2>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        Each date shows how many tasks have a Baseline Date that day, colored by the day's main stage.
        Click a date to see what's due.
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
        <button
          type="button"
          className="kpi-card kpi-card-clickable"
          onClick={jumpToBusiest}
          disabled={!busiest}
          title={busiest ? `Jump to ${busiest.date} and show what's due` : undefined}
        >
          <div className="kpi-label">Busiest Day</div>
          <div className="kpi-value">{busiest ? busiest.count : "—"}</div>
          <div className="kpi-sub">{busiest ? busiest.date : "No deliveries in range"}</div>
        </button>
        <div className="kpi-card">
          <div className="kpi-label">In Range</div>
          <div className="kpi-value">{filteredEvents.length}</div>
          <div className="kpi-sub">task deliveries</div>
        </div>
      </div>

      <MonthlyBreakdown events={dateRangeEvents} stageOrder={stageOrder} />

      <div className="calendar-widget">
        <div className="calendar-header">
          <button type="button" className="btn-secondary" onClick={() => shiftPage(-1)} style={{ margin: 0 }}>
            ← 3 months
          </button>
          <button type="button" className="btn-secondary" onClick={jumpToToday} style={{ margin: 0 }}>
            Today
          </button>
          <button type="button" className="btn-secondary" onClick={() => shiftPage(1)} style={{ margin: 0 }}>
            3 months →
          </button>
        </div>

        {stageOrder.length > 0 && (
          <div className="calendar-legend">
            {stageOrder.map((s) => (
              <span className="calendar-legend-item" key={s}>
                <span className="calendar-legend-dot" style={{ background: stageColor(s, stageOrder) }} />
                {s}
              </span>
            ))}
            <span className="calendar-legend-item">
              <span className="calendar-legend-dot calendar-legend-today" />
              Today
            </span>
          </div>
        )}

        <div className="calendar-page-grid">
          {pageMonths.map(({ year, month }) => {
            const firstDayOfWeek = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const cells: (number | null)[] = [];
            for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) cells.push(d);
            const monthTotal = Array.from(eventsByDate.entries()).reduce(
              (sum, [key, list]) => (key.startsWith(`${year}-${pad(month + 1)}`) ? sum + list.length : sum),
              0
            );

            return (
              <div className="calendar-month" key={`${year}-${month}`}>
                <div className="calendar-month-header">
                  <strong>{monthLabel(year, month)}</strong>
                  <span className="hint" style={{ margin: 0 }}>
                    {monthTotal} deliveries
                  </span>
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
                    const hasIssue = dayEvents.some((e) => e.overdue || e.blocked);
                    const mix = dayEvents.length > 0 ? stageMix(dayEvents) : [];

                    return (
                      <button
                        type="button"
                        key={idx}
                        className={[
                          "calendar-cell",
                          isToday ? "calendar-cell-today" : "",
                          isSelected ? "calendar-cell-selected" : "",
                          hasIssue ? "calendar-cell-issue" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => dayEvents.length > 0 && setSelectedDate(isSelected ? null : key)}
                        disabled={dayEvents.length === 0}
                        title={dayEvents.length > 0 ? `${dayEvents.length} due ${key}` : key}
                      >
                        <span className="calendar-date-num">{d}</span>
                        {dayEvents.length > 0 && (
                          <>
                            <span
                              className="calendar-count-badge"
                              style={{ background: stageColor(dominantStage(dayEvents), stageOrder) }}
                            >
                              {dayEvents.length}
                            </span>
                            <span className="calendar-day-stack">
                              {mix.map((s) => (
                                <span
                                  key={s.name}
                                  style={{
                                    width: `${(s.count / dayEvents.length) * 100}%`,
                                    background: stageColor(s.name, stageOrder),
                                  }}
                                />
                              ))}
                            </span>
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
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
