"use client";

import { useEffect, useRef } from "react";
import {
  Chart,
  ChartData,
  ChartOptions,
  ChartTypeRegistry,
  CategoryScale,
  LinearScale,
  BarElement,
  BarController,
  LineElement,
  LineController,
  PointElement,
  ArcElement,
  DoughnutController,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

// Registered once, module-wide — covers every chart type the dashboard uses
// (bar, horizontal bar via indexAxis, line, doughnut).
Chart.register(
  CategoryScale,
  LinearScale,
  BarElement,
  BarController,
  LineElement,
  LineController,
  PointElement,
  ArcElement,
  DoughnutController,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface ChartCanvasProps {
  type: keyof ChartTypeRegistry;
  data: ChartData;
  options?: ChartOptions;
  height?: number;
}

/**
 * Thin wrapper around Chart.js for the dashboard's widgets. Kept as a plain
 * canvas + imperative Chart instance (rather than a heavier React charting
 * library) to keep the dependency footprint small. Recreates the chart
 * whenever its data/options change — dashboard datasets are small, so this
 * is cheap and avoids fighting Chart.js's own update diffing.
 */
export default function ChartCanvas({ type, data, options, height = 240 }: ChartCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const dataKey = JSON.stringify(data);
  const optionsKey = JSON.stringify(options ?? {});

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type,
      data,
      options: { responsive: true, maintainAspectRatio: false, ...options },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, dataKey, optionsKey]);

  return (
    <div style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
