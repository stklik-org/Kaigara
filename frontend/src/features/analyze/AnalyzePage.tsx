import { Badge } from "@/components/ui/Badge";
import { Panel, SectionLabel } from "@/components/ui/Panel";
import { AreaCIChart } from "@/components/charts/AreaCIChart";
import { BarChart } from "@/components/charts/BarChart";
import { BoxPlotChart } from "@/components/charts/BoxPlotChart";
import { DualLineChart } from "@/components/charts/DualLineChart";
import { HistogramChart } from "@/components/charts/HistogramChart";
import { PercentileChart } from "@/components/charts/PercentileChart";
import { useApi } from "@/lib/api/ApiContext";
import { useAsyncData } from "@/lib/useAsyncData";

/** The run this screen reports on. Hardcoded because `analysis` is the one slice still served from
 *  mock data — it becomes the `?runId=` the Run screen already carries once the backend can
 *  produce a real analysis. */
const MOCK_RUN_ID = "run-482";

/** Mirrors the wireframe's Analyze screen (2e/2eL) — every breakdown is per load Track rather than
 *  per graph branch (`throughputByTrack`, `latencyByTrack`; see shared-types' analysis.ts). */
export function AnalyzePage() {
  const api = useApi();
  const { data: analysis } = useAsyncData(() => api.analysis.get(MOCK_RUN_ID), [api]);

  if (!analysis) {
    return <div className="p-6 text-sm text-ink-muted">Loading analysis…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">{analysis.scenarioName}</h1>
        <div className="text-xs text-ink-muted">
          {analysis.connectionName} · {analysis.timestamp} · {analysis.durationLabel}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {analysis.stats.map((stat) => (
          <Panel key={stat.label} className="p-3">
            <div className="text-[12px] tracking-wide text-ink-muted uppercase">{stat.label}</div>
            <div className="mt-1 text-lg font-semibold text-ink">{stat.value}</div>
            {stat.ci && <div className="text-[12px] text-ink-muted">{stat.ci}</div>}
          </Panel>
        ))}
      </div>

      <Panel className="p-4">
        <SectionLabel>Throughput</SectionLabel>
        <div className="mt-2">
          <AreaCIChart series={analysis.throughput} />
        </div>
      </Panel>

      <div>
        <SectionLabel>Throughput by track</SectionLabel>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {analysis.throughputByTrack.map((track) => (
            <Panel key={track.trackId} className="p-3">
              <div className="mb-1 truncate text-xs font-medium text-ink">{track.label}</div>
              <AreaCIChart series={track.series} />
            </Panel>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel className="p-4">
          <SectionLabel>Latency percentiles</SectionLabel>
          <div className="mt-2">
            <PercentileChart series={analysis.latencyPercentiles} />
          </div>
        </Panel>
        <Panel className="p-4">
          <SectionLabel>Latency distribution</SectionLabel>
          <div className="mt-2">
            <HistogramChart bins={analysis.latencyHistogram} />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel className="p-4">
          <SectionLabel>Latency by track</SectionLabel>
          <div className="mt-2">
            <BoxPlotChart stats={analysis.latencyByTrack} />
          </div>
        </Panel>
        <Panel className="p-4">
          <SectionLabel>Resource usage</SectionLabel>
          <div className="mt-2">
            <DualLineChart
              series={[
                { label: "CPU", points: analysis.resourceUsage.cpu, color: "warn" },
                { label: "Memory", points: analysis.resourceUsage.memory, color: "accent" },
              ]}
            />
          </div>
        </Panel>
      </div>

      <Panel className="p-4">
        <SectionLabel>Error breakdown</SectionLabel>
        <div className="mt-2">
          <BarChart entries={analysis.errorBreakdown} />
        </div>
      </Panel>

      <Panel className="p-4">
        <SectionLabel>Correctness checks</SectionLabel>
        <div className="mt-2 space-y-1.5">
          {analysis.correctnessChecks.map((check) => (
            <div key={`${check.phase}-${check.name}`} className="flex items-center justify-between text-sm">
              <span className="text-ink">
                <span className="text-ink-muted">{check.phase}:</span> {check.name}
              </span>
              <Badge tone={check.passed ? "pass" : "fail"}>{check.passed ? "passed" : "failed"}</Badge>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="p-4">
        <SectionLabel>AI summary</SectionLabel>
        <p className="mt-2 text-sm text-ink">{analysis.aiSummary}</p>
      </Panel>
    </div>
  );
}
