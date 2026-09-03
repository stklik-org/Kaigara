import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { ScenarioLibraryView } from "@kaigara/shared-types";
import { useApi } from "../../lib/api/ApiContext";
import { Panel, SectionLabel } from "../../components/ui/Panel";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { useScenarioStore } from "../compose/store/scenarioStore";
import { MAX_SCENARIO_FILE_BYTES, ScenarioFileError, formatBytes, readScenarioFile } from "./scenarioFile";

/** How many validation issues the error panel spells out before collapsing the rest into a
 *  "+ N more" line — enough to see a pattern, not enough to bury the page. */
const MAX_LISTED_ISSUES = 6;

interface LoadFailure {
  message: string;
  issues: { path: string; message: string }[];
}

/** Mirrors the wireframe's Load screen (2b/2bL): a file loader (drop zone + Browse files, see
 *  scenarioFile.ts for the accepted document shapes) alongside the scenario library — a folder of
 *  serialized scenario documents the backend serves (`backend/scenarios/`). Both are the same
 *  kind of document read by the same parser, so the two halves of this screen differ only in
 *  where the bytes come from. Picking anything here hands the Scenario to scenarioStore and jumps
 *  to Compose, which reads whatever was just loaded instead of re-fetching its own default. */
export function LoadPage() {
  const api = useApi();
  const navigate = useNavigate();
  const loadScenario = useScenarioStore((s) => s.loadScenario);
  const [library, setLibrary] = useState<ScenarioLibraryView | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [readingFilename, setReadingFilename] = useState<string | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  // Counter, not a boolean: dragging over a child element fires dragleave on the parent, so a
  // plain flag would flicker the highlight off as the pointer crosses the zone's own text.
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.scenarios.library().then(
      (view) => {
        if (!cancelled) setLibrary(view);
      },
      // The library is a folder on the orchestrator's disk, so "no backend" is the usual reason
      // this fails — say so instead of leaving the section spinning forever.
      (error: Error) => {
        if (!cancelled) setLibraryError(error.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  // A file dropped anywhere *outside* the zone would otherwise make the browser navigate away to
  // it, silently discarding whatever is loaded. Swallow those drops app-wide while this screen
  // is mounted; the zone's own handler stops propagation before this sees them.
  useEffect(() => {
    const swallow = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  async function openFile(file: File) {
    setFailure(null);
    setReadingFilename(file.name);
    try {
      const scenario = await readScenarioFile(file);
      setReadingFilename(null);
      loadScenario(scenario);
      navigate("/compose");
    } catch (error) {
      setReadingFilename(null);
      setFailure(
        error instanceof ScenarioFileError
          ? { message: error.message, issues: error.issues.filter((issue) => issue.severity === "error") }
          : { message: `Could not read ${file.name} — ${(error as Error).message}`, issues: [] },
      );
    }
  }

  function acceptFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setFailure({ message: "Drop a single scenario file — loading several at once isn't supported.", issues: [] });
      return;
    }
    void openFile(files[0]);
  }

  function handleDrop(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    acceptFiles(event.dataTransfer.files);
  }

  function handleDragEnter(event: ReactDragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function handleDragOver(event: ReactDragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function browse() {
    fileInputRef.current?.click();
  }

  async function openFromLibrary(id: string) {
    setPendingId(id);
    setFailure(null);
    try {
      const scenario = await api.scenarios.instantiate(id);
      loadScenario(scenario);
      navigate("/compose");
    } catch (error) {
      setPendingId(null);
      setFailure({
        message: `Could not open "${id}" — ${(error as Error).message}`,
        issues: (error as { issues?: LoadFailure["issues"] }).issues ?? [],
      });
    }
  }

  const busy = readingFilename !== null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <SectionLabel>Scenario file</SectionLabel>
        <Panel
          dashed
          role="button"
          tabIndex={0}
          aria-label="Drop a scenario file here, or press Enter to browse"
          aria-busy={busy}
          onClick={browse}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              browse();
            }
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className={`mt-2 flex cursor-pointer flex-col items-center justify-center gap-2 p-10 text-center transition-colors ${
            dragActive ? "border-accent bg-accent-bg" : "hover:border-border-strong hover:bg-surface-sunken"
          }`}
        >
          <div className="text-sm font-medium text-ink">
            {busy ? `Reading ${readingFilename}…` : dragActive ? "Release to load" : "Drop a scenario file here"}
          </div>
          <div className="text-xs text-ink-muted">
            JSON — a full scenario, or a bare method timeline (max {formatBytes(MAX_SCENARIO_FILE_BYTES)})
          </div>
          <Button
            variant="secondary"
            className="mt-1"
            disabled={busy}
            onClick={(event) => {
              // The panel itself is the picker trigger; without this the click would bubble up
              // and open the dialog a second time.
              event.stopPropagation();
              browse();
            }}
          >
            Browse files…
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              acceptFiles(event.target.files);
              // Reset so re-picking the same file (e.g. after fixing it on disk) still fires.
              event.target.value = "";
            }}
          />
        </Panel>

        {failure && (
          <Panel role="alert" className="mt-3 border-status-fail bg-status-fail-bg p-3">
            <div className="text-sm font-medium text-status-fail">{failure.message}</div>
            {failure.issues.length > 0 && (
              <ul className="mt-2 space-y-1">
                {failure.issues.slice(0, MAX_LISTED_ISSUES).map((issue, index) => (
                  <li key={`${issue.path}-${index}`} className="text-xs text-ink-muted">
                    <span className="font-mono text-ink">{issue.path || "<root>"}</span> — {issue.message}
                  </li>
                ))}
                {failure.issues.length > MAX_LISTED_ISSUES && (
                  <li className="text-xs text-ink-muted">+ {failure.issues.length - MAX_LISTED_ISSUES} more</li>
                )}
              </ul>
            )}
          </Panel>
        )}
      </div>

      <div>
        <SectionLabel>Scenario library</SectionLabel>
        {library !== null && (
          <div className="mt-2 text-xs text-ink-muted">
            Served from{" "}
            <span className="font-mono text-ink">{library.directory}</span> — copy a scenario file
            in there and it shows up here.
          </div>
        )}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {libraryError !== null ? (
            <Panel role="alert" className="col-span-full border-status-fail bg-status-fail-bg p-3">
              <div className="text-sm font-medium text-status-fail">The scenario library is unavailable</div>
              <div className="mt-1 text-xs text-ink-muted">{libraryError}</div>
            </Panel>
          ) : library === null ? (
            <div className="text-sm text-ink-muted">Loading…</div>
          ) : library.entries.length === 0 ? (
            <Panel className="col-span-full p-4 text-sm text-ink-muted">
              No scenario files in the library folder yet.
            </Panel>
          ) : (
            library.entries.map((entry) => {
              // A file that failed to load is shown rather than hidden — "where did my scenario
              // go?" is a worse question than a stated reason it cannot be opened.
              const broken = entry.issues !== undefined && entry.issues.length > 0;
              return (
                <Panel key={entry.id} className={`flex flex-col gap-2 p-4 ${broken ? "border-status-fail" : ""}`}>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-semibold text-ink">{entry.name}</div>
                      {broken && <Badge tone="fail">Unreadable</Badge>}
                    </div>
                    <div className={`mt-1 text-xs ${broken ? "text-status-fail" : "text-ink-muted"}`}>
                      {entry.description}
                    </div>
                    {broken && (
                      <ul className="mt-2 space-y-1">
                        {entry.issues!.slice(0, MAX_LISTED_ISSUES).map((issue, index) => (
                          <li key={`${issue.path}-${index}`} className="text-xs text-ink-muted">
                            <span className="font-mono text-ink">{issue.path || "<root>"}</span> — {issue.message}
                          </li>
                        ))}
                        {entry.issues!.length > MAX_LISTED_ISSUES && (
                          <li className="text-xs text-ink-muted">+ {entry.issues!.length - MAX_LISTED_ISSUES} more</li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                    <span className="font-mono text-xs text-ink-muted">{entry.file}</span>
                    <Button
                      variant="primary"
                      disabled={broken || pendingId === entry.id}
                      onClick={() => openFromLibrary(entry.id)}
                    >
                      {pendingId === entry.id ? "Opening…" : "Open"}
                    </Button>
                  </div>
                </Panel>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
