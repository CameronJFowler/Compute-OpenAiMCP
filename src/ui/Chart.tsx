import {
  Chart as ChartJS,
  registerables,
  type ChartConfiguration,
} from "chart.js";
import { useEffect, useRef } from "react";

// Bundled from npm, never a CDN: the page must work with no third-party
// network requests at all.
ChartJS.register(...registerables);

export const CHART_COLORS = {
  grid: "#1c2128",
  tick: "#67707c",
  accent: "#d9a441",
  pos: "#5aa87f",
  neg: "#c97b74",
  info: "#5f93c0",
  violet: "#8f86c4",
  ink: "#e4e9ef",
};

/** Muted and flat. Distinguishable without being loud. */
export const SERIES_PALETTE = [
  "#d9a441", "#5f93c0", "#5aa87f", "#c97b74", "#8f86c4", "#a89a6a",
];

const TICK_FONT = { size: 10, family: "ui-monospace, monospace" };

/** Axis defaults shared by every chart, so they read as one instrument. */
export function baseScales(xTitle?: string, yTitle?: string) {
  return {
    x: {
      grid: { color: CHART_COLORS.grid, drawTicks: false },
      border: { color: CHART_COLORS.grid },
      ticks: {
        color: CHART_COLORS.tick,
        font: TICK_FONT,
        maxRotation: 0,
        autoSkipPadding: 28,
      },
      title: xTitle
        ? { display: true, text: xTitle, color: CHART_COLORS.tick, font: { size: 10 } }
        : undefined,
    },
    y: {
      grid: { color: CHART_COLORS.grid, drawTicks: false },
      border: { color: CHART_COLORS.grid },
      ticks: { color: CHART_COLORS.tick, font: TICK_FONT },
      title: yTitle
        ? { display: true, text: yTitle, color: CHART_COLORS.tick, font: { size: 10 } }
        : undefined,
    },
  };
}

export const BASE_PLUGINS = {
  legend: {
    labels: {
      color: CHART_COLORS.tick,
      boxWidth: 8,
      boxHeight: 8,
      padding: 14,
      font: { size: 10, family: "ui-sans-serif, system-ui, sans-serif" },
    },
  },
  tooltip: {
    backgroundColor: "#161a20",
    borderColor: "#2b323b",
    borderWidth: 1,
    padding: 8,
    displayColors: false,
    titleColor: CHART_COLORS.ink,
    bodyColor: CHART_COLORS.ink,
    titleFont: { size: 11, family: "ui-monospace, monospace" },
    bodyFont: { size: 11, family: "ui-monospace, monospace" },
  },
};

export function ChartCanvas({
  config,
  height = 240,
}: {
  config: ChartConfiguration;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new ChartJS(canvasRef.current, config);
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [config]);

  return (
    <div style={{ height, position: "relative" }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
