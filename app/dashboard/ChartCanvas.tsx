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
  /** Fired when a bar/segment is clicked — gets that element's label (from data.labels), plus its dataset/element index. */
  onElementClick?: (label: string, datasetIndex: number, index: number) => void;
}

/**
 * Thin wrapper around Chart.js for the dashboard's widgets. Kept as a plain
 * canvas + imperative Chart instance (rather than a heavier React charting
 * library) to keep the dependency footprint small. Recreates the chart
 * whenever its data/options change — dashboard datasets are small, so this
 * is cheap and avoids fighting Chart.js's own update diffing.
 */
export default function ChartCanvas({ type, data, options, height = 240, onElementClick }: ChartCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  // Held in a ref (not a useEffect dep) so a new inline callback each render
  // doesn't force the whole chart to be torn down and rebuilt.
  const onElementClickRef = useRef(onElementClick);
  onElementClickRef.current = onElementClick;

  const dataKey = JSON.stringify(data);
  const optionsKey = JSON.stringify(options ?? {});

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type,
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        ...options,
        onClick: (_event, elements) => {
          const handler = onElementClickRef.current;
          const chart = chartRef.current;
          if (!handler || !chart || elements.length === 0) return;
          const el = elements[0];
          const label = String(chart.data.labels?.[el.index] ?? "");
          handler(label, el.datasetIndex, el.index);
        },
      },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, dataKey, optionsKey]);

  return (
    <div style={{ height, cursor: onElementClick ? "pointer" : undefined }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
