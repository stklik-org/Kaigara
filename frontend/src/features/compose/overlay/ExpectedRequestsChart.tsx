import { useMemo, useState } from "react";
import type { Track } from "@kaigara/shared-types";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { scaleLinear } from "@/components/charts/scale";
import { formatMMSS } from "../timeline/formatTime";
import { SCALE_SECONDS, SIDEBAR_WIDTH_DEFAULT } from "../timeline/timelineConstants";
import type { ScrollMetrics } from "../timeline/TimelineView";
import { computeTrackRateCurves, type TrackRateCurve } from "./computeRateCurve";

type OverlayMode = "overlaid" | "stacked";

const MODE_OPTIONS: { value: OverlayMode; label: string }[] = [
  { value: "overlaid", label: "Overlaid" },
  { value: "stacked", label: "Stacked" },
];

const PAD_TOP = 6;
/** Room for the x-axis tick labels. */
const PAD_BOTTOM = 20;
const Y_TICK_COUNT = 4;
const MIN_PLOT_HEIGHT = 90;

/** Running totals per sample index, bottom curve to top — the stacked mode's bands. */
function stackCurves(curves: TrackRateCurve[]): number[][] {
  let running = curves[0]?.values.map(() => 0) ?? [];
  return curves.map((curve) => {
    running = curve.values.map((value, i) => value + running[i]);
    return running;
  });
}

/** The wireframe's bottom "Expected requests overlay" panel — a combined request-rate preview
 *  across all tracks, toggling between each track's own line (overlaid) and a cumulative stacked
 *  area.
 *
 *  `scaleWidth` and `scroll` are the values TimelineView uses and reports, so this chart renders
 *  at the identical px-per-second scale and horizontal offset as the timeline above it: any Load's
 *  time position lines up directly underneath its block. */
export function ExpectedRequestsChart({
  tracks,
  totalDurationSeconds,
  scaleWidth,
  scroll,
  plotHeight,
  gutterWidth = SIDEBAR_WIDTH_DEFAULT,
}: {
  tracks: Track[];
  totalDurationSeconds: number;
  scaleWidth: number;
  scroll: ScrollMetrics;
  plotHeight: number;
  /** Width of the y-axis gutter — kept equal to TimelineView's (resizable) track-name column so
   *  the plot area starts at the same x as the timeline's action area above it. */
  gutterWidth?: number;
}) {
  const [mode, setMode] = useState<OverlayMode>("overlaid");
  const height = Math.max(MIN_PLOT_HEIGHT, Math.round(plotHeight));

  // The library sizes its own scrollable extent to the furthest action, which can reach past the
  // authored total length; follow it so the two x-axes still describe the same span.
  const timelineDurationFromWidth = scaleWidth > 0 ? (scroll.contentWidth * SCALE_SECONDS) / scaleWidth : 0;
  const effectiveDurationSeconds = Math.max(totalDurationSeconds, Math.round(timelineDurationFromWidth));
  const axisDurationSeconds = Math.max(1, effectiveDurationSeconds);

  const curves = useMemo(
    () => computeTrackRateCurves(tracks, effectiveDurationSeconds),
    [tracks, effectiveDurationSeconds],
  );
  const sampleCount = curves[0]?.values.length ?? 1;

  const fallbackWidth = Math.max(1, (effectiveDurationSeconds * scaleWidth) / SCALE_SECONDS);
  const plotWidth = Math.max(1, scroll.contentWidth || fallbackWidth);

  const x = scaleLinear([0, sampleCount - 1], [0, plotWidth]);
  const maxY = useMemo(() => {
    const perSample =
      mode === "overlaid" ? curves.map((c) => c.values) : [stackCurves(curves).at(-1) ?? [0]];
    return Math.max(1, ...perSample.flat());
  }, [curves, mode]);
  const y = scaleLinear([0, maxY], [height - PAD_BOTTOM, PAD_TOP]);

  /** Sample index → x, for a time in seconds. */
  const xAt = (seconds: number) => x((seconds / axisDurationSeconds) * (sampleCount - 1));

  const overlaidLines = useMemo(
    () => curves.map((c) => ({ ...c, points: c.values.map((v, i) => `${x(i)},${y(v)}`).join(" ") })),
    [curves, x, y],
  );

  const stackedAreas = useMemo(() => {
    const cumulative = stackCurves(curves);
    return curves.map((curve, i) => {
      const top = cumulative[i];
      const bottom = i > 0 ? cumulative[i - 1] : top.map(() => 0);
      const points = `${top.map((v, j) => `${x(j)},${y(v)}`).join(" ")} ${bottom
        .map((v, j) => `${x(j)},${y(v)}`)
        .reverse()
        .join(" ")}`;
      return { ...curve, points };
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
        <SegmentedControl label="Overlay mode" value={mode} options={MODE_OPTIONS} onChange={setMode} />
      </div>

      <div className="mb-1.5 flex flex-wrap gap-3 text-[12px]">
        {curves.map((curve) => (
          <span key={curve.trackId} className="flex items-center gap-1 text-ink-muted">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: curve.color }} />
            {curve.label}
          </span>
        ))}
      </div>

      <div className="flex" style={{ height }}>
        <div className="flex-none" style={{ width: gutterWidth }}>
          <svg width="100%" height={height} className="overflow-visible">
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
            scrolls, mirroring TimelineView's reported scrollLeft so the two stay pixel-aligned. */}
        <div
          className={`overflow-hidden ${scroll.viewportWidth > 0 ? "flex-none" : "min-w-0 flex-1"}`}
          style={scroll.viewportWidth > 0 ? { width: scroll.viewportWidth } : undefined}
        >
          <div style={{ width: plotWidth, transform: `translateX(-${scroll.scrollLeft}px)` }}>
            <svg width={plotWidth} height={height}>
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
                  x1={xAt(t)}
                  x2={xAt(t)}
                  y1={PAD_TOP}
                  y2={height - PAD_BOTTOM}
                  stroke="var(--color-border)"
                  strokeWidth={1}
                />
              ))}
              <line
                x1={0}
                x2={plotWidth}
                y1={height - PAD_BOTTOM}
                y2={height - PAD_BOTTOM}
                stroke="var(--color-border-strong)"
                strokeWidth={1}
              />
              <line x1={0} x2={0} y1={PAD_TOP} y2={height - PAD_BOTTOM} stroke="var(--color-border-strong)" strokeWidth={1} />
              {mode === "overlaid"
                ? overlaidLines.map((line) => (
                    <polyline key={line.trackId} points={line.points} fill="none" strokeWidth={2} stroke={line.color} />
                  ))
                : stackedAreas.map((area) => (
                    <polygon key={area.trackId} points={area.points} opacity={0.75} fill={area.color} />
                  ))}
              {xTicks.map((t) => (
                <text
                  key={t}
                  x={xAt(t)}
                  y={height - 4}
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
