"use client";

import { useMemo } from "react";

interface MonthEvent {
  date: string; // yyyy-mm-dd
  taskLabel: string;
}

interface StageCount {
  name: string;
  count: number;
}

interface MonthBucket {
  key: string; // yyyy-mm
  label: string; // "May 2026"
  total: number;
  stages: StageCount[];
}

const PALETTE = ["#1d4e6d", "#3f7fa6", "#7fb3d5", "#f26b22", "#8faa3c", "#a56cc1", "#c2410c", "#0f766e"];

function stageColor(name: string, order: string[]): string {
  const idx = order.indexOf(name);
  return PALETTE[idx >= 0 ? idx % PALETTE.length : 0];
}

/**
 * "By Month · Stage Breakdown" — one card per month with deliveries (tasks
 * with a Baseline Date that month), a stacked bar showing the stage/task-type
 * mix, and a per-stage list with mini bars. Mirrors the reference dashboard's
 * "By Month · Subject Breakdown" widget, using Stage/Task Type as our
 * equivalent grouping dimension (we don't have a "subject" field).
 */
export default function MonthlyBreakdown({ events }: { events: MonthEvent[] }) {
  const { buckets, stageOrder } = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    const stageFirstSeen: string[] = [];

    events.forEach((e) => {
      const monthKey = e.date.slice(0, 7); // yyyy-mm
      if (!map.has(monthKey)) map.set(monthKey, new Map());
      const stageMap = map.get(monthKey)!;
      stageMap.set(e.taskLabel, (stageMap.get(e.taskLabel) ?? 0) + 1);
      if (!stageFirstSeen.includes(e.taskLabel)) stageFirstSeen.push(e.taskLabel);
    });

    const sortedKeys = Array.from(map.keys()).sort();
    const built: MonthBucket[] = sortedKeys.map((key) => {
      const stageMap = map.get(key)!;
      const stages = Array.from(stageMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      const total = stages.reduce((sum, s) => sum + s.count, 0);
      const [y, m] = key.split("-").map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
      return { key, label, total, stages };
    });

    return { buckets: built, stageOrder: stageFirstSeen };
  }, [events]);

  if (buckets.length === 0) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>By Month · Stage Breakdown</h3>
      <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
        Deliveries per month (by Baseline Date), split by task stage.
      </p>
      <div className="month-strip">
        {buckets.map((b) => {
          const maxCount = b.stages[0]?.count ?? 1;
          return (
            <div className="month-card" key={b.key}>
              <div className="month-card-label">{b.label.toUpperCase()}</div>
              <div className="month-card-total">{b.total}</div>
              <div className="month-card-sub">deliveries this month</div>
              <div className="month-stacked-bar">
                {b.stages.map((s) => (
                  <span
                    key={s.name}
                    style={{
                      width: `${(s.count / b.total) * 100}%`,
                      background: stageColor(s.name, stageOrder),
                    }}
                    title={`${s.name}: ${s.count}`}
                  />
                ))}
              </div>
              <div className="month-stage-list">
                {b.stages.map((s) => (
                  <div className="month-stage-row" key={s.name}>
                    <span className="month-stage-name" title={s.name}>
                      {s.name}
                    </span>
                    <span className="month-stage-bar-track">
                      <span
                        className="month-stage-bar-fill"
                        style={{
                          width: `${(s.count / maxCount) * 100}%`,
                          background: stageColor(s.name, stageOrder),
                        }}
                      />
                    </span>
                    <span className="month-stage-count">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
