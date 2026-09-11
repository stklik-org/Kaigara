import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScenarioFileError, type ScenarioLibraryEntry } from "@kaigara/shared-types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IssueList } from "@/components/ui/IssueList";
import { Panel, SectionLabel } from "@/components/ui/Panel";
import { generateScenario } from "@/lib/assist/generateScenario";
import { loadLlmConfig } from "@/lib/assist/llmConfig";
import { useApi } from "@/lib/api/ApiContext";
import { useAsyncData } from "@/lib/useAsyncData";
import { useScenarioStore } from "../compose/store/scenarioStore";
import { readScenarioFile } from "./scenarioFile";
import { ScenarioDropZone } from "./ScenarioDropZone";
import { GenerateFromDescription } from "./GenerateFromDescription";

interface LoadFailure {
  message: string;
  issues: { path: string; message: string }[];
}

/** Anything that came back with issues cannot be opened — but it is still listed, because "where
 *  did my scenario go?" is a worse question than a stated reason it won't open. */
function issuesOf(entry: ScenarioLibraryEntry) {
  return entry.issues ?? [];
}

function FailurePanel({
  title,
  failure,
  className = "",
}: {
  /** Headline when the message itself is detail rather than a summary. */
  title?: string;
  failure: LoadFailure;
  className?: string;
}) {
  return (
    <Panel role="alert" className={`border-status-fail bg-status-fail-bg p-3 ${className}`}>
      <div className="text-sm font-medium text-status-fail">{title ?? failure.message}</div>
      {title && <div className="mt-1 text-xs text-ink-muted">{failure.message}</div>}
      {failure.issues.length > 0 && <IssueList issues={failure.issues} />}
    </Panel>
  );
}

function LibraryCard({
  entry,
  opening,
  onOpen,
}: {
  entry: ScenarioLibraryEntry;
  opening: boolean;
  onOpen: () => void;
}) {
  const issues = issuesOf(entry);
  const broken = issues.length > 0;

  return (
    <Panel className={`flex flex-col gap-2 p-4 ${broken ? "border-status-fail" : ""}`}>
      <div>
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-ink">{entry.name}</div>
          {broken && <Badge tone="fail">Unreadable</Badge>}
        </div>
        <div className={`mt-1 text-xs ${broken ? "text-status-fail" : "text-ink-muted"}`}>{entry.description}</div>
        {broken && <IssueList issues={issues} />}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="font-mono text-xs text-ink-muted">{entry.file}</span>
        <Button variant="primary" disabled={broken || opening} onClick={onOpen}>
          {opening ? "Opening…" : "Open"}
        </Button>
      </div>
    </Panel>
  );
}

/** Mirrors the wireframe's Load screen (2b/2bL): a file loader (drop zone + Browse files) beside
 *  the scenario library — a folder of serialized scenario documents the backend serves
 *  (`backend/scenarios/`). Both halves are the same kind of document read by the same parser, so
 *  they differ only in where the bytes come from. Picking anything here hands the Scenario to
 *  scenarioStore and jumps to Compose, which reads whatever was just loaded instead of re-fetching
 *  its own default. */
export function LoadPage() {
  const api = useApi();
  const navigate = useNavigate();
  const loadScenario = useScenarioStore((s) => s.loadScenario);
  // The library is a folder on the orchestrator's disk, so "no backend" is the usual reason this
  // fails — the error is shown rather than leaving the section spinning forever.
  const { data: library, error: libraryError } = useAsyncData(() => api.scenarios.library(), [api]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [readingFilename, setReadingFilename] = useState<string | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);

  function open(scenario: Parameters<typeof loadScenario>[0]) {
    loadScenario(scenario);
    navigate("/compose");
  }

  async function openFiles(files: File[]) {
    setFailure(null);
    if (files.length > 1) {
      setFailure({ message: "Drop a single scenario file — loading several at once isn't supported.", issues: [] });
      return;
    }
    const file = files[0];
    setReadingFilename(file.name);
    try {
      open(await readScenarioFile(file));
    } catch (error) {
      setFailure(
        error instanceof ScenarioFileError
          ? { message: error.message, issues: error.issues.filter((issue) => issue.severity === "error") }
          : { message: `Could not read ${file.name} — ${(error as Error).message}`, issues: [] },
      );
    } finally {
      setReadingFilename(null);
    }
  }

  /** The description box hands its text here; `generateScenario` calls the configured LLM, validates
   *  the reply with the same gate as the drop zone, and returns a Scenario to open in Compose.
   *  Errors propagate to the panel, which shows the message. */
  async function generateFromDescription(description: string) {
    setFailure(null);
    open(await generateScenario(description, loadLlmConfig()));
  }

  async function openFromLibrary(id: string) {
    setPendingId(id);
    setFailure(null);
    try {
      open(await api.scenarios.instantiate(id));
    } catch (error) {
      setPendingId(null);
      setFailure({
        message: `Could not open "${id}" — ${(error as Error).message}`,
        issues: (error as { issues?: LoadFailure["issues"] }).issues ?? [],
      });
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <GenerateFromDescription onGenerate={generateFromDescription} />

      <div>
        <SectionLabel>Scenario file</SectionLabel>
        <ScenarioDropZone busyWith={readingFilename} onFiles={openFiles} />
        {failure && <FailurePanel failure={failure} className="mt-3" />}
      </div>

      <div>
        <SectionLabel>Scenario library</SectionLabel>
        {library && (
          <div className="mt-2 text-xs text-ink-muted">
            Served from <span className="font-mono text-ink">{library.directory}</span> — copy a scenario file in there
            and it shows up here.
          </div>
        )}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {libraryError ? (
            <FailurePanel
              title="The scenario library is unavailable"
              failure={{ message: libraryError.message, issues: [] }}
              className="col-span-full"
            />
          ) : !library ? (
            <div className="text-sm text-ink-muted">Loading…</div>
          ) : library.entries.length === 0 ? (
            <Panel className="col-span-full p-4 text-sm text-ink-muted">
              No scenario files in the library folder yet.
            </Panel>
          ) : (
            library.entries.map((entry) => (
              <LibraryCard
                key={entry.id}
                entry={entry}
                opening={pendingId === entry.id}
                onOpen={() => openFromLibrary(entry.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
