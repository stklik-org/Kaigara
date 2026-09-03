import { useMemo, useState } from "react";
import type { Track } from "@kaigara/shared-types";
import { scaleLinear } from "../../../components/charts/scale";
import { formatMMSS } from "../timeline/formatTime";
import { SCALE_SECONDS } from "../timeline/timelineConstants";
import { computeTrackRateCurves } from "./computeRateCurve";

type OverlayMode = "overlaid" | "stacked";

const PAD_TOP = 6;
const PAD_BOTTOM = 20; // room for the x-axis tick labels
const Y_TICK_COUNT = 4;

/** The wireframe's bottom "Expected requests overlay" panel — a combined request-rate preview
 *  across all tracks, toggling between each track's own line (overlaid) and a cumulative stacked
 *  area. `scaleWidth`/`scrollLeft` are the same values TimelineView uses/reports, so this chart's
 *  x-axis renders at the identical px-per-second scale and horizontal scroll offset as the
 *  timeline above it — i.e. any Load's time position lines up directly underneath its block. */
export function ExpectedRequestsChart({
  tracks,
  totalDurationSeconds,
  scaleWidth,
  scrollLeft,
  viewportWidth,
  contentWidth,
  plotHeight,
  gutterWidth = 180,
}: {
  tracks: Track[];
  totalDurationSeconds: number;
  scaleWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
  plotHeight: number;
  /** Width of the y-axis gutter — kept equal to TimelineView's (resizable) track-name column so
   *  the plot area starts at the same x as the timeline's action area above it. */
  gutterWidth?: number;
}) {
  const [mode, setMode] = useState<OverlayMode>("overlaid");
  const H = Math.max(90, Math.round(plotHeight));
  const timelineDurationFromWidth = useMemo(() => (scaleWidth > 0 ? (contentWidth * SCALE_SECONDS) / scaleWidth : 0), [contentWidth, scaleWidth]);
  const effectiveDurationSeconds = Math.max(totalDurationSeconds, Math.round(timelineDurationFromWidth));
  const axisDurationSeconds = Math.max(1, effectiveDurationSeconds);
  const curves = useMemo(
    () => computeTrackRateCurves(tracks, effectiveDurationSeconds),
    [tracks, effectiveDurationSeconds],
  );
  const sampleCount = curves[0]?.values.length ?? 1;

  const fallbackWidth = Math.max(1, (effectiveDurationSeconds * scaleWidth) / SCALE_SECONDS);
  const plotWidth = Math.max(1, contentWidth || fallbackWidth);
  const x = scaleLinear([0, sampleCount - 1], [0, plotWidth]);

  const maxY = useMemo(() => {
    if (mode === "overlaid") return Math.max(1, ...curves.flatMap((c) => c.values));
    const totals = curves[0]?.values.map((_, i) => curves.reduce((sum, c) => sum + c.values[i], 0)) ?? [0];
    return Math.max(1, ...totals);
  }, [curves, mode]);
  const y = scaleLinear([0, maxY], [H - PAD_BOTTOM, PAD_TOP]);

  const overlaidLines = useMemo(
    () =>
      curves.map((c) => ({
        trackId: c.trackId,
        color: c.color,
        points: c.values.map((v, i) => `${x(i)},${y(v)}`).join(" "),
      })),
    [curves, x, y],
  );

  const stackedAreas = useMemo(() => {
    let runningTotal = curves[0]?.values.map(() => 0) ?? [];
    const cumulative = curves.map((c) => {
      const next = c.values.map((v, i) => v + runningTotal[i]);
      runningTotal = next;
      return next;
    });

    return curves.map((c, i) => {
      const top = cumulative[i];
      const bottom = i > 0 ? cumulative[i - 1] : top.map(() => 0);
      const topPoints = top.map((v, j) => `${x(j)},${y(v)}`).join(" ");
      const bottomPoints = bottom
        .map((v, j) => `${x(j)},${y(v)}`)
        .reverse()
        .join(" ");
      return { trackId: c.trackId, color: c.color, points: `${topPoints} ${bottomPoints}` };
    });
  }, [curves, x, y]);

  const yTicks = useMemo(
    () => Array.from({ length: Y_TICK_COUNT + 1 }, (_, i) => (maxY / Y_TICK_COUNT) * i),
    [maxY],
  );

  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let t = 0; t <= axisDurationSeconds; t += SCALE_SECONDS) ticks.push(t);
    return ticks;
  }, [axisDurationSeconds]);

  return (
    <div className="h-full p-3 pb-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-semibold tracking-wide text-ink-muted uppercase">
          Expected requests overlay
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border-strong p-0.5">
          <button
            type="button"
            onClick={() => setMode("overlaid")}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              mode === "overlaid" ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            Overlaid
          </button>
          <button
            type="button"
            onClick={() => setMode("stacked")}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              mode === "stacked" ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            Stacked
          </button>
        </div>
      </div>

      <div className="mb-1.5 flex flex-wrap gap-3 text-[12px]">
        {curves.map((c) => (
          <span key={c.trackId} className="flex items-center gap-1 text-ink-muted">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
            {c.label}
          </span>
        ))}
      </div>

      <div className="flex" style={{ height: H }}>
        <div className="flex-none" style={{ width: gutterWidth }}>
          <svg width="100%" height={H} className="overflow-visible">
            {yTicks.map((value) => (
              <text
                key={value}
                x="100%"
                y={y(value)}
                dy={value === 0 ? -2 : 4}
                textAnchor="end"
                className="fill-ink-muted"
                style={{ fontSize: 11 }}
              >
                {Math.round(value)}/s
              </text>
            ))}
          </svg>
        </div>
        {/* Clips to the timeline's own visible width; the inner translated div is what actually
         *  scrolls, mirroring TimelineView's reported scrollLeft so the two stay pixel-aligned. */}
        <div className={`overflow-hidden ${viewportWidth > 0 ? "flex-none" : "min-w-0 flex-1"}`} style={viewportWidth > 0 ? { width: viewportWidth } : undefined}>
          <div style={{ width: plotWidth, transform: `translateX(-${scrollLeft}px)` }}>
            <svg width={plotWidth} height={H}>
              {yTicks.map((value) => (
                <line
                  key={value}
                  x1={0}
                  x2={plotWidth}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="var(--color-border)"
                  strokeWidth={1}
                />
              ))}
              {xTicks.map((t) => (
                <line
                  key={t}
                  x1={x((t / axisDurationSeconds) * (sampleCount - 1))}
                  x2={x((t / axisDurationSeconds) * (sampleCount - 1))}
                  y1={PAD_TOP}
                  y2={H - PAD_BOTTOM}
                  stroke="var(--color-border)"
                  strokeWidth={1}
                />
              ))}
              {/* axis lines */}
              <line x1={0} x2={plotWidth} y1={H - PAD_BOTTOM} y2={H - PAD_BOTTOM} stroke="var(--color-border-strong)" strokeWidth={1} />
              <line x1={0} x2={0} y1={PAD_TOP} y2={H - PAD_BOTTOM} stroke="var(--color-border-strong)" strokeWidth={1} />
              {mode === "overlaid"
                ? overlaidLines.map((line) => (
                    <polyline
                      key={line.trackId}
                      points={line.points}
                      fill="none"
                      strokeWidth={2}
                      stroke={line.color}
                    />
                  ))
                : stackedAreas.map((area) => (
                    <polygon key={area.trackId} points={area.points} opacity={0.75} fill={area.color} />
                  ))}
              {xTicks.map((t) => (
                <text
                  key={t}
                  x={x((t / axisDurationSeconds) * (sampleCount - 1))}
                  y={H - 4}
                  textAnchor="middle"
                  className="fill-ink-muted"
                  style={{ fontSize: 11 }}
                >
                  {formatMMSS(t)}
                </text>
              ))}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
