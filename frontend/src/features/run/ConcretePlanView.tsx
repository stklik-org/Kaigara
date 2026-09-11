import type { ConcretePlan, ConcretePlanEntry } from "@kaigara/shared-types";
import { formatMMSS } from "../compose/timeline/formatTime";

function Centered({ children, tone }: { children: React.ReactNode; tone?: "fail" }) {
  return (
    <div className={`p-10 text-center text-sm ${tone === "fail" ? "text-status-fail" : "text-ink-muted"}`}>{children}</div>
  );
}

/** One compiled load: the k6-scenario header (start · duration · executor · rate) plus a row per
 *  authored request type with its expected total. A load with one request type is one row; a
 *  ramp-down with four is four. */
function EntryBlock({ entry }: { entry: ConcretePlanEntry }) {
  const end = entry.startSeconds + entry.durationSeconds;
  return (
    <div className="border-b border-border">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-surface-sunken px-4 py-2">
        <span className="font-mono text-[12px] text-ink">
          t={formatMMSS(entry.startSeconds)} → {formatMMSS(end)}
          <span className="text-ink-muted"> ({entry.durationSeconds}s)</span>
        </span>
        <span className="text-[13px] font-semibold text-ink">{entry.trackLabel}</span>
        <span className="text-[12px] text-ink-muted">{entry.rateSummary}</span>
        <span className="ml-auto flex items-baseline gap-3">
          <span className="rounded border border-border-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            {entry.executor}
          </span>
          <span className="font-mono text-[12px] text-ink">~{entry.expectedRequests.toLocaleString()} req</span>
        </span>
      </div>
      <table className="w-full border-collapse text-left font-mono text-[12px]">
        <tbody>
          {entry.requests.map((line) => (
            <tr key={line.requestId} className="border-t border-border">
              <td className="w-16 px-4 py-1 font-semibold text-ink">{line.method}</td>
              <td className="px-2 py-1 break-all text-ink-muted">{line.path}</td>
              <td className="w-16 px-2 py-1 text-right tabular-nums text-ink-muted">{Math.round(line.share * 100)}%</td>
              <td className="w-28 px-4 py-1 text-right tabular-nums text-ink">
                ~{line.expectedRequests.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Run screen's "Concrete plan" debug view: the compiled timeline as the load tool sees it —
 * one entry per load (k6 scenario), with its start time, duration, executor and rate, broken down
 * into the request types it issues and how many of each. Computed by
 * `POST /api/runs/concrete-plan`; nothing runs. Totals are expectations — the engine picks each
 * request by weighted random draw.
 */
export function ConcretePlanView({
  plan,
  loading,
  error,
}: {
  plan: ConcretePlan | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <Centered>Compiling the concrete plan…</Centered>;
  if (error) return <Centered tone="fail">{error}</Centered>;
  if (!plan) return <Centered>Toggle this on to compile the current timeline into an engine plan.</Centered>;

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex-none border-b border-border px-4 py-2 text-xs text-ink-muted">
        <span className="font-medium text-ink">Concrete execution plan</span> — {plan.scenarioName}{" "}
        <span className="text-ink-muted">→</span> <span className="font-mono">{plan.targetBaseUrl}</span>
        {" · "}
        {plan.entries.length} load{plan.entries.length === 1 ? "" : "s"}
        {" · "}~{plan.expectedRequests.toLocaleString()} requests over {formatMMSS(plan.totalDurationSeconds)}
      </div>

      {plan.warnings.length > 0 && (
        <div className="flex-none border-b border-border px-4 py-1.5 text-[12px] text-status-warn">
          {plan.warnings.length} composition warning{plan.warnings.length === 1 ? "" : "s"} — {plan.warnings[0].message}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {plan.entries.length === 0 ? (
          <Centered>This timeline compiles to no loads.</Centered>
        ) : (
          plan.entries.map((entry) => <EntryBlock key={entry.loadKey} entry={entry} />)
        )}
      </div>
    </div>
  );
}
