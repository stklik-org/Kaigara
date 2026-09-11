import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ConcretePlan, RunView } from "@kaigara/shared-types";
import { HeaderActionsSlot, HeaderScenarioSlot } from "@/app/HeaderSlots";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/Panel";
import { Sparkline } from "@/components/charts/Sparkline";
import { useApi } from "@/lib/api/ApiContext";
import { RunRequestError } from "@/lib/api/runsClient";
import { useAsyncData } from "@/lib/useAsyncData";
import { useScenarioStore } from "../compose/store/scenarioStore";
import { formatMMSS } from "../compose/timeline/formatTime";
import { ConcretePlanView } from "./ConcretePlanView";
import { RunTimelineView } from "./RunTimelineView";

const STATUS_TONE: Record<RunView["status"], BadgeTone> = {
  compiled: "neutral",
  starting: "neutral",
  running: "pass",
  completed: "pass",
  failed: "fail",
  stopped: "warn",
};

const LIVE_STATUSES: RunView["status"][] = ["running", "starting"];

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "fail" }) {
  return (
    <div className="text-center">
      <div className={`text-lg font-semibold ${tone === "fail" ? "text-status-fail" : "text-ink"}`}>{value}</div>
      <div className="text-[12px] text-ink-muted">{label}</div>
    </div>
  );
}

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-lg p-10 text-center">{children}</div>;
}

/**
 * The Run screen. Its own title bar is gone — the scenario/target/status/clock and the
 * Run/Stop/Concrete-plan controls portal into AppShell's header (see HeaderSlots.tsx), so there is
 * one bar, not two.
 *
 * Compose's Run button no longer launches anything; it just brings you here. This screen decides
 * *when* to start: the header carries a **Run** button next to **Stop**, and pressing it posts the
 * timeline (read from `scenarioStore`) against the active connection. Arriving with `?runId=` — a
 * deep link, or a reload — follows that run instead.
 *
 * The **Concrete plan** toggle swaps the live track canvas for `ConcretePlanView`: the compiled
 * timeline expanded into "at time T, these requests" — computed by the backend, running nothing.
 */
export function RunPage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const scenarioName = useScenarioStore((s) => s.scenarioName);
  const timeline = useScenarioStore((s) => s.timeline);

  const [activeRunId, setActiveRunId] = useState<string | null>(() => searchParams.get("runId"));
  const [run, setRun] = useState<RunView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const [showPlan, setShowPlan] = useState(false);
  const [plan, setPlan] = useState<ConcretePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const { data: connections } = useAsyncData(() => api.connections.list(), [api]);
  const activeConnection = connections?.find((connection) => connection.active) ?? null;

  const hasTimeline = timeline.tracks.length > 0;

  // Follow the active run: one fetch for immediate content, then the live stream while it runs.
  useEffect(() => {
    if (!activeRunId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setLoadError(null);

    api.runs.detail(activeRunId).then(
      (view) => {
        if (cancelled) return;
        setRun(view);
        if (!LIVE_STATUSES.includes(view.status)) return;
        unsubscribe = api.runs.subscribeDetail(activeRunId, (next) => {
          if (!cancelled) setRun(next);
        });
      },
      (cause: unknown) => {
        if (!cancelled) setLoadError((cause as Error).message);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, activeRunId]);

  // A timeline edit in Compose invalidates a plan already fetched here.
  useEffect(() => {
    setPlan(null);
  }, [timeline]);

  // Compile the concrete plan the first time it is shown (and after it was invalidated).
  useEffect(() => {
    if (!showPlan || plan || planLoading || !hasTimeline) return;
    if (!activeConnection) {
      setPlanError("Activate a target on the Connect screen — the plan resolves request URLs against it.");
      return;
    }
    setPlanLoading(true);
    setPlanError(null);
    api.runs
      .concretePlan({ timeline, connection: activeConnection, scenarioName: scenarioName || undefined })
      .then(
        (result) => setPlan(result),
        (cause: unknown) => setPlanError((cause as Error).message),
      )
      .finally(() => setPlanLoading(false));
  }, [showPlan, plan, planLoading, hasTimeline, activeConnection, api, timeline, scenarioName]);

  async function handleRun() {
    if (!activeConnection || !hasTimeline || starting) return;
    setStarting(true);
    setActionError(null);
    try {
      const view = await api.runs.start({
        timeline,
        connection: activeConnection,
        scenarioName: scenarioName || undefined,
      });
      setRun(view);
      setActiveRunId(view.id);
      setSearchParams({ runId: view.id }, { replace: true });
    } catch (cause) {
      const issues = cause instanceof RunRequestError ? cause.issues.filter((issue) => issue.severity === "error") : [];
      setActionError(
        issues.length > 0 ? `${issues[0].path || "timeline"}: ${issues[0].message}` : (cause as Error).message,
      );
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!activeRunId) return;
    setStopping(true);
    try {
      setRun(await api.runs.stop(activeRunId));
    } catch (cause) {
      setActionError((cause as Error).message);
    } finally {
      setStopping(false);
    }
  }

  // Nothing composed and nothing to follow — there is genuinely nothing to show.
  if (!activeRunId && !hasTimeline) {
    return (
      <CenteredNotice>
        <div className="text-sm font-medium text-ink">Nothing to run</div>
        <p className="mt-2 text-sm text-ink-muted">
          Compose a scenario first, then come back here to compile it, inspect the concrete plan, and start the run.
        </p>
        <Link to="/compose" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
          Go to Compose →
        </Link>
      </CenteredNotice>
    );
  }

  if (loadError && !run) {
    return (
      <CenteredNotice>
        <div className="text-sm font-medium text-status-fail">Could not load run</div>
        <p className="mt-2 font-mono text-xs text-ink-muted">{loadError}</p>
        <p className="mt-3 text-xs text-ink-muted">
          Runs are held in the orchestrator's memory, so they do not survive a backend restart. Start the backend with{" "}
          <span className="font-mono">npm run dev -w backend</span>.
        </p>
      </CenteredNotice>
    );
  }

  const isRunning = run ? LIVE_STATUSES.includes(run.status) : false;
  const statusLabel = run ? (isRunning ? "● RUNNING" : run.status.toUpperCase()) : "READY";
  const statusTone: BadgeTone = run ? STATUS_TONE[run.status] : "neutral";
  const elapsed = run?.state.elapsedSeconds ?? 0;
  const total = run?.state.totalSeconds ?? Math.round(timeline.totalDurationSeconds);
  const targetLabel = run?.targetBaseUrl ?? activeConnection?.baseUrl ?? "no active target";
  const canRun = hasTimeline && Boolean(activeConnection) && !starting && !isRunning;
  const dropped = run?.engineSummary?.droppedIterations ?? 0;
  const latestReqPerSec = run?.state.requestsPerSecondSeries.at(-1) ?? 0;

  return (
    <div className="flex h-full flex-col">
      <HeaderScenarioSlot>
        <span className="max-w-[13rem] truncate text-sm font-medium text-ink">
          {scenarioName || run?.scenarioName || "Untitled"}
        </span>
        <span className="max-w-[11rem] truncate font-mono text-[11px] text-ink-muted" title={targetLabel}>
          {targetLabel}
        </span>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </HeaderScenarioSlot>
      <HeaderActionsSlot>
        {actionError && (
          <span className="max-w-xs truncate text-xs text-status-fail" title={actionError}>
            {actionError}
          </span>
        )}
        <Button
          variant={showPlan ? "primary" : "secondary"}
          aria-pressed={showPlan}
          onClick={() => setShowPlan((value) => !value)}
          title="Show the compiled request schedule without running anything"
        >
          Concrete plan
        </Button>
        <span className="flex-none font-mono text-xs tabular-nums text-ink-muted">
          {formatMMSS(elapsed)} / {formatMMSS(total)}
        </span>
        <Button
          variant="primary"
          disabled={!canRun}
          onClick={handleRun}
          title={
            activeConnection
              ? `Run against ${activeConnection.name} (${activeConnection.baseUrl})`
              : "Activate a server connection on the Connect screen first"
          }
        >
          {starting ? "Starting…" : run && !isRunning ? "Run again" : "Run"}
        </Button>
        <Button variant="danger" disabled={!isRunning || stopping} onClick={handleStop}>
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      </HeaderActionsSlot>

      {run && run.warnings.length > 0 && (
        <div className="flex-none border-b border-border bg-surface px-4 py-1.5 text-[12px] text-status-warn">
          {run.warnings.length} composition warning{run.warnings.length === 1 ? "" : "s"} — {run.warnings[0].message}
        </div>
      )}

      {dropped > 0 && (
        // A saturated engine means the tool, not the server, was the limit — the numbers below do
        // not describe the target's capacity, so say so rather than letting them be read as if.
        <div className="flex-none border-b border-border bg-surface px-4 py-1.5 text-[12px] text-status-fail">
          {dropped} iteration{dropped === 1 ? "" : "s"} dropped: the load generator could not keep up, so these results
          understate the server's capacity.
        </div>
      )}

      <div className="min-h-0 flex-1">
        {showPlan ? (
          <ConcretePlanView plan={plan} loading={planLoading} error={planError} />
        ) : (
          <RunTimelineView tracks={timeline.tracks} elapsedSeconds={elapsed} />
        )}
      </div>

      {run && (
        <div className="grid flex-none grid-cols-3 divide-x divide-border border-t border-border bg-surface">
          <div className="p-3">
            <SectionLabel>Req/sec — active tracks</SectionLabel>
            <Sparkline values={run.state.requestsPerSecondSeries} className="mt-2 h-16 w-full" />
          </div>
          <div className="p-3">
            <SectionLabel>Error log</SectionLabel>
            <div className="mt-2 max-h-24 space-y-0.5 overflow-y-auto font-mono text-[13px] text-status-fail">
              {run.state.errorLog.length === 0 ? (
                <div className="text-ink-muted">No errors yet.</div>
              ) : (
                run.state.errorLog.map((entry, i) => (
                  <div key={`${entry.timestamp}-${i}`}>
                    {entry.timestamp} {entry.message}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="flex items-center justify-around p-3">
            <Stat label="REQ/S" value={latestReqPerSec} />
            <Stat label="TOTAL" value={run.metrics.requests} />
            <Stat label="FAILED" value={run.metrics.failed} tone="fail" />
            <Stat label="P95 MS" value={run.metrics.percentiles.p95} />
          </div>
        </div>
      )}
    </div>
  );
}
