import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ConcretePlan, RunArchiveEntry, RunRequestLog, RunView } from "@kaigara/shared-types";
import { parseLoadTimeline } from "@kaigara/shared-types";
import { HeaderActionsSlot, HeaderScenarioSlot } from "@/app/HeaderSlots";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/Panel";
import { ResizableColumns } from "@/components/ui/ResizableColumns";
import { ResizableRows } from "@/components/ui/ResizableRows";
import { Sparkline } from "@/components/charts/Sparkline";
import { useApi } from "@/lib/api/ApiContext";
import { RunRequestError } from "@/lib/api/runsClient";
import { useAsyncData } from "@/lib/useAsyncData";
import { useScenarioStore } from "../compose/store/scenarioStore";
import { findLoad } from "../compose/timeline/findLoad";
import { formatMMSS } from "../compose/timeline/formatTime";
import { useActiveRunStore } from "./activeRunStore";
import { ArchivePickerDialog } from "./ArchivePickerDialog";
import { ConcretePlanView } from "./ConcretePlanView";
import { RequestResponseView } from "./RequestResponseView";
import { runViewFromArchive } from "./runArchiveView";
import { RunCompositionPanel } from "./RunCompositionPanel";
import { RunLoadShapePanel } from "./RunLoadShapePanel";
import { RunTimelineView } from "./RunTimelineView";

const PANE_SIZES_KEY = "kaigara.run.paneSizes";
const INFO_COLUMN_SIZES_KEY = "kaigara.run.infoColumns";
const INFO_MIN_HEIGHT = 150;
const INFO_DEFAULT_HEIGHT = 300;
const INFO_MAX_HEIGHT = 640;
const TIMELINE_MIN_HEIGHT = 156;

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
  const setTimeline = useScenarioStore((s) => s.setTimeline);
  const setScenarioName = useScenarioStore((s) => s.setScenarioName);

  const [activeRunId, setActiveRunId] = useState<string | null>(() => searchParams.get("runId"));
  const [run, setRun] = useState<RunView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // "Open previous execution": `archiveId` names a run from GET /api/runs/archive rather than the
  // in-memory RunService state `activeRunId` follows — set, the two other effects below step
  // aside so a reopened run's synthetic RunView (see `runArchiveView.ts`) is not immediately
  // clobbered by a 404 from asking the live backend about a run it never executed.
  const [archiveId, setArchiveId] = useState<string | null>(() => searchParams.get("archiveId"));
  const [archiveOpenError, setArchiveOpenError] = useState<string | null>(null);
  const [archivePickerOpen, setArchivePickerOpen] = useState(false);
  const [archiveEntries, setArchiveEntries] = useState<RunArchiveEntry[] | null>(null);
  const [archiveListLoading, setArchiveListLoading] = useState(false);
  const [archiveListError, setArchiveListError] = useState<string | null>(null);

  const [showPlan, setShowPlan] = useState(false);
  const [plan, setPlan] = useState<ConcretePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // The complete per-request log, fetched once — never on the live-tick cadence `run` updates on
  // — after the run reaches a terminal status. Until then (and if the fetch fails) the request log
  // panel falls back to `run.metrics.recentSamples`, the bounded live tail.
  const [fullLog, setFullLog] = useState<RunRequestLog | null>(null);
  // True only while the fetch below is in flight — distinguishes "still loading" from "loaded and
  // genuinely empty" in `RequestResponseView`, which otherwise cannot tell the two apart just from
  // `fullLog` being `null` in both cases.
  const [fullLogLoading, setFullLogLoading] = useState(false);

  // Which Load a click on the timeline opened details for — local to this screen, not
  // scenarioStore's own `selectedLoadId`: that one drives Compose's editable panels, and this
  // selection is read-only browsing, not "now editing this Load" (see RunLoadShapePanel's and
  // RunCompositionPanel's own doc comments for why the two must not share state). Unlike Compose's
  // own selection (a plain "last clicked wins" setter — see scenarioStore's `selectLoad`), clicking
  // the already-selected Load here toggles it back to `null` (the `RunTimelineView` onSelectLoad
  // below) — with nothing else on this screen to click to clear a selection (no empty-canvas click
  // handler, since nothing here is authored), that is the only way back to the general summary.
  const [selectedLoadId, setSelectedLoadId] = useState<string | null>(null);
  const selectedLoad = findLoad(timeline, selectedLoadId);

  const { data: connections } = useAsyncData(() => api.connections.list(), [api]);
  const activeConnection = connections?.find((connection) => connection.active) ?? null;

  const hasTimeline = timeline.tracks.length > 0;

  // Follow the active run: one fetch for immediate content, then the live stream while it runs.
  // Steps aside entirely while viewing an archived run — see `archiveId`'s own doc comment.
  useEffect(() => {
    if (archiveId) return;
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
  }, [api, activeRunId, archiveId]);

  // A timeline edit in Compose invalidates a plan already fetched here.
  useEffect(() => {
    setPlan(null);
  }, [timeline]);

  // A different run, or a different Load selection, invalidates whatever full log was fetched for
  // the previous one — `GET /api/runs/:id/requests` is scoped to one `loadId` now (CLAUDE.md: the
  // Run screen only ever renders one Load's log at a time, and a finished run's complete log can be
  // hundreds of thousands of samples), so there is no single "the" full log to keep around any more.
  useEffect(() => {
    setFullLog(null);
    setFullLogLoading(false);
  }, [activeRunId, archiveId, selectedLoadId]);

  // Fetches the request log for the *selected* Load only, once the run (live or archived) reaches a
  // terminal status — not on the live-tick cadence `run` otherwise updates on, per `RunRequestLog`'s
  // own doc comment. Works the same for a live run (`activeRunId`) and an archived one
  // (`archivedRunId`, its bare runId — the same endpoint serves both, see `runArchive.ts`).
  // `run`/`archivedRunId` are excluded from the dependency list on purpose beyond `run?.status`:
  // every live tick creates a new `run` object, and re-running this on each one would re-fetch
  // nothing useful before `fullLog` is set anyway.
  const archivedRunId = archiveId ? run?.id : undefined;
  const runId = activeRunId ?? archivedRunId;
  useEffect(() => {
    if (!runId || !selectedLoadId || !run || LIVE_STATUSES.includes(run.status) || fullLog) return;
    let cancelled = false;
    setFullLogLoading(true);
    api.runs.requestLog(runId, selectedLoadId).then(
      (log) => {
        if (cancelled) return;
        setFullLog(log);
        setFullLogLoading(false);
      },
      () => {
        // Best-effort: the request-response panel still works off the live tail if this fails.
        if (!cancelled) setFullLogLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [runId, selectedLoadId, run?.status, fullLog, api]);

  // "Open previous execution": reopens an archived run — restores the *authored* timeline it was
  // compiled from into scenarioStore (so Compose and this screen's own shape/composition panels
  // work exactly as they would for a live run) and projects the rest onto a synthetic `RunView`
  // (`runArchiveView.ts`) so every other Run screen component needs no archived-vs-live branch of
  // its own at all.
  useEffect(() => {
    if (!archiveId) return;
    let cancelled = false;
    setArchiveOpenError(null);
    api.runs.archiveDetail(archiveId).then(
      (detail) => {
        if (cancelled) return;
        if (detail.timeline) {
          try {
            setTimeline(parseLoadTimeline(detail.timeline));
            setScenarioName(detail.manifest.scenarioName);
          } catch (cause) {
            setArchiveOpenError(`This run's archived timeline no longer validates: ${(cause as Error).message}`);
          }
        }
        // No `detail.requestLog` any more — an archived run's request log is fetched lazily per
        // selected Load, the same as a live run's, by the effect below (`api.runs.requestLog`).
        setRun(runViewFromArchive(detail));
      },
      (cause: unknown) => {
        if (!cancelled) setArchiveOpenError((cause as Error).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, archiveId, setTimeline, setScenarioName]);

  // Mirrors live status out to `activeRunStore`, which AppShell's stage nav reads to refuse
  // navigating away from a run in progress — see that store's own doc comment for why. The
  // unmount cleanup is a safety net, not the normal path: leaving this screen while genuinely
  // running should already be blocked by the nav itself.
  useEffect(() => {
    useActiveRunStore.getState().setIsRunning(run ? LIVE_STATUSES.includes(run.status) : false);
  }, [run]);
  useEffect(() => () => useActiveRunStore.getState().setIsRunning(false), []);

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
      setArchiveId(null);
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

  async function openArchivePicker() {
    setArchivePickerOpen(true);
    setArchiveListLoading(true);
    setArchiveListError(null);
    try {
      setArchiveEntries(await api.runs.archiveList());
    } catch (cause) {
      setArchiveListError((cause as Error).message);
    } finally {
      setArchiveListLoading(false);
    }
  }

  function selectArchiveEntry(entry: RunArchiveEntry) {
    setArchivePickerOpen(false);
    setActiveRunId(null);
    setRun(null);
    setSelectedLoadId(null);
    setArchiveId(entry.id);
    setSearchParams({ archiveId: entry.id }, { replace: true });
  }

  // Nothing composed and nothing to follow — there is genuinely nothing to show.
  if (!activeRunId && !archiveId && !hasTimeline) {
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

  if ((loadError || archiveOpenError) && !run) {
    return (
      <CenteredNotice>
        <div className="text-sm font-medium text-status-fail">{archiveOpenError ? "Could not reopen this run" : "Could not load run"}</div>
        <p className="mt-2 font-mono text-xs text-ink-muted">{archiveOpenError || loadError}</p>
        {!archiveOpenError && (
          <p className="mt-3 text-xs text-ink-muted">
            Runs are held in the orchestrator's memory, so they do not survive a backend restart. Start the backend with{" "}
            <span className="font-mono">npm run dev -w backend</span>.
          </p>
        )}
      </CenteredNotice>
    );
  }

  const isRunning = run ? LIVE_STATUSES.includes(run.status) : false;
  const statusLabel = run ? (isRunning ? "● RUNNING" : run.status.toUpperCase()) : "READY";
  const statusTone: BadgeTone = run ? STATUS_TONE[run.status] : "neutral";
  const elapsed = run?.state.elapsedSeconds ?? 0;
  const total = run?.state.totalSeconds ?? Math.round(timeline.totalDurationSeconds);
  // Once any run — live or archived — is loaded, its own `connectionId`/`targetBaseUrl` is the
  // truth about what it targeted; falling back to whatever connection happens to be active right
  // now would be actively misleading for a reopened archived run pointed at a different server
  // entirely. Only with no run loaded at all does "the target" mean "what Run would use if
  // pressed", which is `activeConnection`.
  const targetConnection = run ? connections?.find((connection) => connection.id === run.connectionId) : activeConnection;
  const targetLabel = targetConnection?.name ?? run?.targetBaseUrl ?? "no active target";
  const targetTitle = targetConnection ? `${targetConnection.name} — ${targetConnection.baseUrl}` : (run?.targetBaseUrl ?? "no active target");
  const canRun = hasTimeline && Boolean(activeConnection) && !starting && !isRunning;
  const dropped = run?.engineSummary?.droppedIterations ?? 0;
  const latestReqPerSec = run?.state.requestsPerSecondSeries.at(-1) ?? 0;

  return (
    <div className="flex h-full flex-col">
      <HeaderScenarioSlot>
        <span className="max-w-[13rem] truncate text-sm font-medium text-ink">
          {scenarioName || run?.scenarioName || "Untitled"}
        </span>
        <span className="max-w-[11rem] truncate text-[11px] text-ink-muted" title={targetTitle}>
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
        <Button onClick={openArchivePicker} title="Reopen a run from the k6 adapter's own archive, including from before the last backend restart">
          Open previous execution
        </Button>
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

      {archiveOpenError && run && (
        <div className="flex-none border-b border-border bg-surface px-4 py-1.5 text-[12px] text-status-fail">{archiveOpenError}</div>
      )}

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

      <ResizableRows
        className="min-h-0 flex-1"
        storageKey={PANE_SIZES_KEY}
        rows={[
          {
            key: "info",
            minHeight: INFO_MIN_HEIGHT,
            defaultHeight: INFO_DEFAULT_HEIGHT,
            maxHeight: INFO_MAX_HEIGHT,
            render: () => (
              <ResizableColumns
                className="h-full border-b border-border bg-surface"
                storageKey={INFO_COLUMN_SIZES_KEY}
                columns={[
                  {
                    key: "shape",
                    minWidth: 168,
                    defaultFraction: 0.25,
                    maxWidth: 640,
                    render: () => <RunLoadShapePanel load={selectedLoad?.load} />,
                  },
                  {
                    key: "composition",
                    minWidth: 240,
                    defaultFraction: 0.25,
                    maxWidth: 900,
                    handleLabel: "Resize the request composition panel",
                    render: () => <RunCompositionPanel load={selectedLoad?.load} />,
                  },
                  {
                    key: "requests",
                    flex: true,
                    minWidth: 260,
                    handleLabel: "Resize the request/response log panel",
                    render: () => (
                      <RequestResponseView run={run} fullLog={fullLog} fullLogLoading={fullLogLoading} selectedLoadId={selectedLoadId} />
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "timeline",
            flex: true,
            minHeight: TIMELINE_MIN_HEIGHT,
            handleLabel: "Resize timeline panel",
            render: () => (
              <div className="h-full border-t border-border bg-surface">
                {showPlan ? (
                  <ConcretePlanView plan={plan} loading={planLoading} error={planError} />
                ) : (
                  <RunTimelineView
                    tracks={timeline.tracks}
                    elapsedSeconds={elapsed}
                    selectedLoadId={selectedLoadId}
                    onSelectLoad={(loadId) => setSelectedLoadId((current) => (current === loadId ? null : loadId))}
                    live={!run || isRunning}
                  />
                )}
              </div>
            ),
          },
        ]}
      />

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

      {archivePickerOpen && (
        <ArchivePickerDialog
          entries={archiveEntries}
          loading={archiveListLoading}
          error={archiveListError}
          onSelect={selectArchiveEntry}
          onClose={() => setArchivePickerOpen(false)}
        />
      )}
    </div>
  );
}
