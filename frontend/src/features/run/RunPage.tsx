import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { RunView } from "@kaigara/shared-types";
import { useApi } from "../../lib/api/ApiContext";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SectionLabel } from "../../components/ui/Panel";
import { Sparkline } from "../../components/charts/Sparkline";
import { useScenarioStore } from "../compose/store/scenarioStore";
import { formatMMSS } from "../compose/timeline/formatTime";
import { RunTimelineView } from "./RunTimelineView";

const STATUS_TONE: Record<RunView["status"], BadgeTone> = {
  compiled: "neutral",
  starting: "neutral",
  running: "pass",
  completed: "pass",
  failed: "fail",
  stopped: "warn",
};

/** Mirrors the wireframe's Run screen (2d/2dL) — same track-stack layout as Compose, now live.
 *
 *  The run is identified by `?runId=`, which Compose sets when it posts a timeline. The timeline
 *  itself is read from `scenarioStore` rather than re-fetched: the backend holds an execution plan
 *  (what to send), not the authored document (how it was drawn), and the store already has the
 *  exact composition the user pressed Run on. */
export function RunPage() {
  const api = useApi();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get("runId");
  const timeline = useScenarioStore((s) => s.timeline);

  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setError(null);

    // Fetch once for immediate content, then follow the live stream. Without the initial fetch a
    // run that has already finished would render nothing, since its stream is closed.
    api.runs
      .detail(runId)
      .then((view) => {
        if (cancelled) return;
        setRun(view);
        if (view.status === "running" || view.status === "starting") {
          unsubscribeRef.current = api.runs.subscribeDetail(runId, (next) => {
            if (!cancelled) setRun(next);
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });

    return () => {
      cancelled = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [api, runId]);

  async function handleStop() {
    if (!runId) return;
    setStopping(true);
    try {
      setRun(await api.runs.stop(runId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStopping(false);
    }
  }

  if (!runId) {
    return (
      <div className="mx-auto max-w-lg p-10 text-center">
        <div className="text-sm font-medium text-ink">No run selected</div>
        <p className="mt-2 text-sm text-ink-muted">
          Compose a scenario and press <span className="font-medium text-ink">Run</span> — the timeline is sent to the
          orchestrator, compiled into an engine script, and executed against the active connection.
        </p>
        <Link to="/compose" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
          Go to Compose →
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-lg p-10 text-center">
        <div className="text-sm font-medium text-status-fail">Could not load run</div>
        <p className="mt-2 font-mono text-xs text-ink-muted">{error}</p>
        <p className="mt-3 text-xs text-ink-muted">
          Runs are held in the orchestrator's memory, so they do not survive a backend restart. Start the backend with{" "}
          <span className="font-mono">npm run dev -w backend</span>.
        </p>
      </div>
    );
  }

  if (!run) return <div className="p-6 text-sm text-ink-muted">Loading run…</div>;

  const isRunning = run.status === "running" || run.status === "starting";
  const latestReqPerSec = run.state.requestsPerSecondSeries.at(-1) ?? 0;
  const dropped = run.engineSummary?.droppedIterations ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-ink">
            {run.scenarioName} <span className="text-ink-muted">→</span> {run.targetBaseUrl}
          </span>
          <Badge tone={STATUS_TONE[run.status]}>
            {isRunning ? "● RUNNING" : run.status.toUpperCase()}
          </Badge>
        </div>
        <div className="font-mono text-sm text-ink-muted">
          {formatMMSS(run.state.elapsedSeconds)} / {formatMMSS(run.state.totalSeconds)}
        </div>
        <div className="flex gap-2">
          <Button variant="danger" disabled={!isRunning || stopping} onClick={handleStop}>
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        </div>
      </div>

      {run.warnings.length > 0 && (
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
        <RunTimelineView tracks={timeline.tracks} elapsedSeconds={run.state.elapsedSeconds} />
      </div>

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
                <div key={i}>
                  {entry.timestamp} {entry.message}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center justify-around p-3">
          <div className="text-center">
            <div className="text-lg font-semibold text-ink">{latestReqPerSec}</div>
            <div className="text-[12px] text-ink-muted">REQ/S</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold text-ink">{run.metrics.requests}</div>
            <div className="text-[12px] text-ink-muted">TOTAL</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold text-status-fail">{run.metrics.failed}</div>
            <div className="text-[12px] text-ink-muted">FAILED</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold text-ink">{run.metrics.percentiles.p95}</div>
            <div className="text-[12px] text-ink-muted">P95 MS</div>
          </div>
        </div>
      </div>
    </div>
  );
}
