import type { RunArchiveEntry } from "@kaigara/shared-types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";

const STATUS_TONE: Record<string, BadgeTone> = {
  completed: "pass",
  stopped: "warn",
  failed: "fail",
};

function formatCalledAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * "Open previous execution"'s picker — every run `GET /api/runs/archive` can still find, across
 * every backend restart. A plain list rather than a table: the fields per entry vary (a run that
 * never started has no status or totals yet), and a list degrades to "just the scenario name and
 * when" instead of a row full of blanks.
 */
export function ArchivePickerDialog({
  entries,
  loading,
  error,
  onSelect,
  onClose,
}: {
  entries: RunArchiveEntry[] | null;
  loading: boolean;
  error: string | null;
  onSelect: (entry: RunArchiveEntry) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation" onClick={onClose}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="Open previous execution"
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-semibold text-ink">Open previous execution</div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close" className="text-ink-muted hover:text-ink">
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && <div className="p-4 text-center text-[12px] text-ink-muted">Loading archived runs…</div>}
          {error && <div className="p-4 text-center text-[12px] text-status-fail">{error}</div>}
          {!loading && !error && entries?.length === 0 && (
            <div className="p-4 text-center text-[12px] text-ink-muted">
              No archived runs found. They live under <span className="font-mono">k6-logs/</span> (or wherever
              <span className="font-mono"> KAIGARA_LOG_DIR</span> points) and appear here once a run has at least compiled.
            </div>
          )}
          {!loading &&
            !error &&
            entries?.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelect(entry)}
                className="flex w-full flex-col gap-1 rounded-md border border-transparent px-3 py-2 text-left hover:border-border-strong hover:bg-field"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">{entry.scenarioName}</span>
                  {entry.status && <Badge tone={STATUS_TONE[entry.status] ?? "neutral"}>{entry.status}</Badge>}
                  <span className="ml-auto flex-none text-[11px] text-ink-muted">{formatCalledAt(entry.calledAt)}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
                  <span className="truncate">{entry.targetBaseUrl}</span>
                  {entry.requests != null && (
                    <span className="flex-none">
                      · {entry.requests} req{entry.failed ? `, ${entry.failed} failed` : ""}
                    </span>
                  )}
                </div>
              </button>
            ))}
        </div>
      </Panel>
    </div>
  );
}
