import { useState } from "react";
import type { RunExchange, RunRequestLog, RunRequestSample, RunView } from "@kaigara/shared-types";
import { useApi } from "@/lib/api/ApiContext";
import { FilterPills } from "../compose/panels/CataloguePanel";
import { PanelLabel } from "../compose/panels/fields";
import { ExchangeDialog } from "./ExchangeDialog";

/** mm:ss.mmm — one decimal place finer than the rest of the Run screen's mm:ss clock, since two
 *  requests routinely complete inside the same second at any real rate. */
function formatOffset(offsetMs: number): string {
  const totalMs = Math.max(0, Math.round(offsetMs));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** `RunRequestSample.offsetMs` is when the response was received (k6 stamps `http_req_duration`
 *  at completion, never at request start — see `parseOutput.ts`'s `toSample()`), so the moment the
 *  request was sent is only recoverable by subtracting the same sample's `durationMs`. */
function formatSentOffset(offsetMs: number, durationMs: number): string {
  return formatOffset(offsetMs - durationMs);
}

/** A tiny capture-completeness glyph for one direction (request or response) of one row: a solid
 *  square when the body was kept whole, a square with a dashed cut edge when it was cut at
 *  `EXCHANGE_CAPTURE_CAP` (64 KB) — see `RunRequestSample.requestTruncated`/`responseTruncated`.
 *  Dependency-free inline SVG, matching `components/charts`' own no-icon-library convention. */
function CaptureIcon({ truncated, label }: { truncated: boolean; label: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label={label} className={truncated ? "text-status-warn" : "text-status-pass"}>
      <title>{label}</title>
      {truncated ? (
        <>
          <rect x="1" y="1" width="8" height="5" fill="currentColor" opacity="0.85" />
          <line x1="1" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.4 1.2" />
        </>
      ) : (
        <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
      )}
    </svg>
  );
}

/** "Capture" cell: nothing to show for a row the engine never captured an exchange for at all
 *  (`exchangeId` absent — see its own doc comment), otherwise one `CaptureIcon` per direction. */
function CaptureCell({ sample }: { sample: RunRequestSample }) {
  if (!sample.exchangeId) return <span className="text-ink-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1" title="Req / resp: solid = stored complete, cut = capped at 64 KB">
      <CaptureIcon truncated={sample.requestTruncated ?? false} label={`Request body ${sample.requestTruncated ? "capped at 64 KB" : "stored complete"}`} />
      <CaptureIcon truncated={sample.responseTruncated ?? false} label={`Response body ${sample.responseTruncated ? "capped at 64 KB" : "stored complete"}`} />
    </span>
  );
}

function statusTone(status: number): string {
  if (status === 0) return "border-border-strong text-ink-muted";
  if (status < 300) return "border-status-pass text-status-pass";
  if (status < 400) return "border-border-strong text-ink-muted";
  return "border-status-fail text-status-fail";
}

function countByStatus(samples: RunRequestSample[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sample of samples) counts[sample.status] = (counts[sample.status] ?? 0) + 1;
  return counts;
}

type SortKey = "sent" | "received" | "load" | "request" | "capture" | "status" | "duration";

/** One clickable column: `value` extracts what to compare rows by, and `defaultDir` is the
 *  direction a first click on that column sorts in — descending for "biggest/most recent first"
 *  columns (time, duration, capture), ascending for the rest, matching what a reader reaches for
 *  first (`request`/`load` alphabetically, `status` numerically low-to-high). `align` mirrors the
 *  cell's own text alignment so the sort arrow sits next to the number/text it belongs to. */
interface Column {
  key: SortKey;
  label: string;
  align: "left" | "right" | "center";
  defaultDir: 1 | -1;
  value: (sample: RunRequestSample, loadLabel: string) => number | string;
}

/** 0 (nothing captured) .. 2 (both bodies cut) — sorts a fully-captured row before a partially cut
 *  one before nothing captured at all, in the `defaultDir: -1` (worst-first) reading. */
function captureScore(sample: RunRequestSample): number {
  if (!sample.exchangeId) return -1;
  return (sample.requestTruncated ? 1 : 0) + (sample.responseTruncated ? 1 : 0);
}

const COLUMNS: Column[] = [
  { key: "sent", label: "Sent", align: "left", defaultDir: -1, value: (s) => s.offsetMs - s.durationMs },
  { key: "received", label: "Received", align: "left", defaultDir: -1, value: (s) => s.offsetMs },
  { key: "load", label: "Load", align: "left", defaultDir: 1, value: (_s, loadLabel) => loadLabel },
  { key: "request", label: "Request", align: "left", defaultDir: 1, value: (s) => `${s.operation} ${s.target}` },
  { key: "capture", label: "Capture", align: "center", defaultDir: -1, value: (s) => captureScore(s) },
  { key: "status", label: "Status", align: "right", defaultDir: 1, value: (s) => s.status },
  { key: "duration", label: "Duration", align: "right", defaultDir: -1, value: (s) => s.durationMs },
];

function compareValues(a: number | string, b: number | string): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

function SortableHeader({
  column,
  active,
  dir,
  onClick,
}: {
  column: Column;
  active: boolean;
  dir: 1 | -1;
  onClick: () => void;
}) {
  const alignClass = column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left";
  const justify = column.align === "right" ? "justify-end" : column.align === "center" ? "justify-center" : "justify-start";
  return (
    <th className={`px-2 py-1 font-medium ${alignClass}`}>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-0.5 ${justify} hover:text-ink`}
        title={`Sort by ${column.label}`}
      >
        {column.label}
        <span className="w-2.5 text-[9px] leading-none">{active ? (dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

/**
 * Third info-row panel on the Run screen, in the catalogue's place — a status-code filter (the
 * same `FilterPills` component the catalogue's own Operation/Target rows use, not a lookalike)
 * over a scrollable log of requests.
 *
 * Two different sources back the table, never both: absent a Load selection (or while the run is
 * still live), it reads `run.metrics.recentSamples` — a small ring buffer re-published every tick
 * (see `metricsAggregator.ts`'s doc comment for why that one stays bounded). Once a Load is
 * selected on a finished run, `RunPage` fetches that Load's complete record from
 * `GET /api/runs/:id/requests?loadId=` (`fullLog`) — deliberately scoped to one Load, since a
 * finished run's whole log can be hundreds of thousands of samples the client never needs at once.
 * Both are filtered the same way, by status and by `selectedLoadId` (a no-op for `fullLog`, which
 * already arrives scoped to it — kept anyway so the live-tail path, which is not scoped, still
 * narrows correctly). `fullLogLoading` (also `RunPage`'s) is what tells the empty-state message
 * apart from a genuine "this Load has nothing" — without it, the in-flight fetch and a Load that
 * really produced zero requests both show `fullLog` as `null`/empty, and read as the same thing.
 *
 * A row with an `exchangeId` opens `ExchangeDialog` on click — the literal request and response
 * the k6 script captured for it (`GET /api/runs/:id/exchanges/:exchangeId`), fetched only then,
 * never preloaded for the whole table. Every request the k6 adapter issues carries one; a row
 * without one (another engine, or an archive from before exchanges existed) is just not clickable.
 */
export function RequestResponseView({
  run,
  fullLog,
  fullLogLoading = false,
  selectedLoadId,
}: {
  run: RunView | null;
  fullLog: RunRequestLog | null;
  /** True while `RunPage` is fetching `fullLog` for the selected Load — lets the empty-state
   *  message below tell "still loading" apart from "loaded and genuinely has nothing". */
  fullLogLoading?: boolean;
  selectedLoadId?: string | null;
}) {
  const api = useApi();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // Defaults to "received, most recent first" — the same order the table showed before it was
  // sortable (`.reverse()` on the oldest-first sample list).
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "received", dir: -1 });

  function toggleSort(column: Column) {
    setSort((current) => (current.key === column.key ? { key: column.key, dir: (current.dir * -1) as 1 | -1 } : { key: column.key, dir: column.defaultDir }));
  }
  const [openExchangeId, setOpenExchangeId] = useState<string | null>(null);
  const [exchange, setExchange] = useState<RunExchange | null>(null);
  const [exchangeLoading, setExchangeLoading] = useState(false);
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  function openExchange(exchangeId: string) {
    if (!run) return;
    setOpenExchangeId(exchangeId);
    setExchange(null);
    setExchangeError(null);
    setExchangeLoading(true);
    api.runs.exchange(run.id, exchangeId).then(
      (found) => {
        setExchange(found);
        setExchangeLoading(false);
      },
      (cause: unknown) => {
        setExchangeError((cause as Error).message);
        setExchangeLoading(false);
      },
    );
  }

  const loadLabels = new Map(run?.plan.loads.map((load) => [load.key, load.label]) ?? []);
  // A Load compiles into one script per request type (CLAUDE.md), so several plan entries can
  // share one `loadId` — the filter has to match any of their keys, not just one.
  const allowedLoadKeys =
    selectedLoadId != null ? new Set(run?.plan.loads.filter((load) => load.loadId === selectedLoadId).map((load) => load.key)) : null;

  const allSamples: RunRequestSample[] = fullLog?.samples ?? run?.metrics.recentSamples ?? [];
  const isCompleteLog = fullLog != null && !fullLog.live;
  const loadFiltered = allowedLoadKeys ? allSamples.filter((sample) => allowedLoadKeys.has(sample.loadKey)) : allSamples;

  // The status counters scope to whatever the table itself is scoped to: the exact run-wide totals
  // when nothing narrows the rows below them, and a count over the load-filtered samples once a
  // Load is selected — `byStatus` has no per-load breakdown, so that is the best available true
  // count once a Load narrows things, live tail or not.
  const byStatus = allowedLoadKeys ? countByStatus(loadFiltered) : (run?.metrics.byStatus ?? countByStatus(allSamples));
  const statusOptions = [
    { value: "all", label: "All" },
    ...Object.keys(byStatus)
      .sort((a, b) => Number(a) - Number(b))
      .map((status) => ({ value: status, label: status === "0" ? "no response" : status })),
  ];
  const totalCount = allowedLoadKeys ? loadFiltered.length : (run?.metrics.requests ?? allSamples.length);
  const counts: Record<string, number> = { all: totalCount, ...byStatus };

  const sortColumn = COLUMNS.find((column) => column.key === sort.key)!;
  const rows = loadFiltered
    .filter((sample) => statusFilter === "all" || String(sample.status) === statusFilter)
    .slice()
    .sort((a, b) => sort.dir * compareValues(sortColumn.value(a, loadLabels.get(a.loadKey) ?? a.loadKey), sortColumn.value(b, loadLabels.get(b.loadKey) ?? b.loadKey)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2 px-2 pt-2">
        <PanelLabel color="var(--color-accent)">Request / response log</PanelLabel>
        <span className="ml-auto pb-1.5 text-[11px] text-ink-muted">
          {isCompleteLog ? `${rows.length} of ${loadFiltered.length} (complete)` : `${rows.length} of last ${loadFiltered.length}`}
        </span>
      </div>

      <div className="flex-none border-b border-border px-2 pb-2">
        <FilterPills label="Status" value={statusFilter} options={statusOptions} counts={counts} onChange={setStatusFilter} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!run ? (
          <div className="p-4 text-center text-[12px] text-ink-muted">Start a run to see requests here.</div>
        ) : fullLogLoading ? (
          <div className="p-4 text-center text-[12px] text-ink-muted">Loading requests for this Load…</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-ink-muted">
            {loadFiltered.length > 0
              ? "No requests match this filter."
              : selectedLoadId != null && fullLog
                ? "This Load produced no requests."
                : "No requests completed yet."}
          </div>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-surface text-[10px] text-ink-muted uppercase">
              <tr className="border-b border-border">
                {COLUMNS.map((column) => (
                  <SortableHeader
                    key={column.key}
                    column={column}
                    active={sort.key === column.key}
                    dir={sort.dir}
                    onClick={() => toggleSort(column)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((sample, index) => (
                <tr
                  key={`${sample.offsetMs}-${index}`}
                  onClick={sample.exchangeId ? () => openExchange(sample.exchangeId!) : undefined}
                  title={sample.exchangeId ? "Open the captured request and response" : "No captured exchange for this request"}
                  className={`border-b border-border ${sample.exchangeId ? "cursor-pointer hover:bg-field" : "opacity-60"}`}
                >
                  <td className="px-2 py-1 font-mono text-ink-muted">{formatSentOffset(sample.offsetMs, sample.durationMs)}</td>
                  <td className="px-2 py-1 font-mono text-ink-muted">{formatOffset(sample.offsetMs)}</td>
                  <td className="max-w-[8rem] truncate px-2 py-1 text-ink" title={loadLabels.get(sample.loadKey) ?? sample.loadKey}>
                    {loadLabels.get(sample.loadKey) ?? sample.loadKey}
                  </td>
                  <td className="px-2 py-1 text-ink">
                    {sample.operation} {sample.target}
                  </td>
                  <td className="px-2 py-1 text-center">
                    <CaptureCell sample={sample} />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <span className={`rounded border px-1.5 py-0.5 font-mono ${statusTone(sample.status)}`}>
                      {sample.status === 0 ? "—" : sample.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-ink-muted">{Math.round(sample.durationMs)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openExchangeId && (
        <ExchangeDialog
          loading={exchangeLoading}
          error={exchangeError}
          exchange={exchange}
          onClose={() => setOpenExchangeId(null)}
        />
      )}
    </div>
  );
}
