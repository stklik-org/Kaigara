import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { loadTimelineSchema, type ValidationIssue } from "@kaigara/shared-types";
import { useTheme } from "../../../app/ThemeContext";
import { useScenarioStore } from "../store/scenarioStore";
import { toText, parseText } from "./scenarioSerialization";

const SCHEMA_URI = "inmemory://load-timeline-schema.json";
const MODEL_PATH = "scenario-method.json";
const DEBOUNCE_MS = 400;
const MAX_LISTED_ISSUES = 6;

type EditorInstance = Parameters<OnMount>[0];

type SyncStatus =
  | { state: "clean" }
  | { state: "synced"; warnings: ValidationIssue[] }
  | { state: "blocked"; issues: ValidationIssue[] };

function IssueList({ issues, tone }: { issues: ValidationIssue[]; tone: "fail" | "warn" }) {
  const color = tone === "fail" ? "text-status-fail" : "text-status-warn";
  return (
    <ul className="space-y-0.5">
      {issues.slice(0, MAX_LISTED_ISSUES).map((issue, i) => (
        <li key={i} className={`flex gap-2 ${color}`}>
          <span className="flex-none font-mono opacity-70">{issue.path || "<root>"}</span>
          <span className="min-w-0 text-ink-muted">{issue.message}</span>
        </li>
      ))}
      {issues.length > MAX_LISTED_ISSUES && (
        <li className="text-ink-muted">…and {issues.length - MAX_LISTED_ISSUES} more</li>
      )}
    </ul>
  );
}

/** Live JSON view of the scenario's method timeline, schema-validated via Monaco's built-in JSON
 *  language service (no `monaco-yaml` needed — see plan). Debounced two-way sync with
 *  scenarioStore: typing here updates the store (and so the Visual view); dragging a Load on the
 *  Visual view updates the text here. `lastEmittedText` breaks the echo loop — a change this
 *  editor itself just produced doesn't get pushed back into itself mid-typing.
 *
 *  Monaco's squiggles cover *schema* violations; the status bar below covers what the schema
 *  can't express (duplicate load ids, loads that send nothing, loads running past the end of the
 *  timeline) and, crucially, tells the user when the text has stopped syncing to the Visual view
 *  and why — previously an invalid edit was swallowed silently, so the two views could drift with
 *  no indication that they had. */
export function CodeEditorView() {
  const timeline = useScenarioStore((s) => s.timeline);
  const setTimeline = useScenarioStore((s) => s.setTimeline);
  const { theme } = useTheme();
  const [status, setStatus] = useState<SyncStatus>({ state: "clean" });

  const editorRef = useRef<EditorInstance | null>(null);
  const lastEmittedText = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = useRef<string | null>(null);

  /** Parse `value` and, when it is a coherent timeline, push it into the store. Returns the status
   *  to display — the caller decides whether to surface it (the unmount flush doesn't: there is no
   *  status bar left to update). */
  function applyText(value: string): SyncStatus {
    const result = parseText(value);
    if (!result.ok) return { state: "blocked", issues: result.issues };
    lastEmittedText.current = value;
    setTimeline(result.timeline);
    return { state: "synced", warnings: result.warnings };
  }

  // Keeps a live handle to applyText for the unmount-only effect below, which must not list it as
  // a dependency (that would re-run — and so flush — on every render).
  const applyTextRef = useRef(applyText);
  useEffect(() => {
    applyTextRef.current = applyText;
  });

  useEffect(() => {
    const text = toText(timeline);
    if (text === lastEmittedText.current) return;
    lastEmittedText.current = text;
    editorRef.current?.setValue(text);
    // An update arriving from the Visual view supersedes whatever the user's last (possibly
    // broken) keystrokes said, so the stale error list has to go with it.
    setStatus({ state: "clean" });
  }, [timeline]);

  useEffect(
    () => () => {
      // Flush a still-pending edit before the view unmounts (e.g. fixing the JSON and immediately
      // clicking back to Visual within the debounce window) so a valid change isn't dropped.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        if (latestValueRef.current !== null) applyTextRef.current(latestValueRef.current);
      }
    },
    [],
  );

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [{ uri: SCHEMA_URI, fileMatch: [MODEL_PATH], schema: loadTimelineSchema }],
    });

    const text = toText(useScenarioStore.getState().timeline);
    lastEmittedText.current = text;
    editor.setValue(text);
  };

  function handleChange(value: string | undefined) {
    if (value === undefined) return;
    latestValueRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      // A "blocked" result doesn't propagate — the Visual view keeps showing the last good
      // document, and the status bar makes that hold visible rather than leaving the user to
      // wonder why nothing moved.
      setStatus(applyText(value));
    }, DEBOUNCE_MS);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Editor
          path={MODEL_PATH}
          defaultLanguage="json"
          theme={theme === "dark" ? "vs-dark" : "vs"}
          onMount={handleMount}
          onChange={handleChange}
          options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true }}
        />
      </div>

      <div className="max-h-32 flex-none overflow-y-auto border-t border-border bg-surface px-3 py-1.5 text-[12px]">
        {status.state === "blocked" ? (
          <>
            <div className="font-medium text-status-fail">
              Not synced — {status.issues.length} error{status.issues.length === 1 ? "" : "s"}. The timeline still shows
              the last valid version.
            </div>
            <div className="mt-1">
              <IssueList issues={status.issues} tone="fail" />
            </div>
          </>
        ) : status.state === "synced" && status.warnings.length > 0 ? (
          <>
            <div className="font-medium text-status-warn">
              Synced to timeline · {status.warnings.length} warning{status.warnings.length === 1 ? "" : "s"}
            </div>
            <div className="mt-1">
              <IssueList issues={status.warnings} tone="warn" />
            </div>
          </>
        ) : (
          <div className="text-ink-muted">
            {status.state === "synced" ? "Synced to timeline — no issues." : "Edits sync to the timeline as you type."}
          </div>
        )}
      </div>
    </div>
  );
}
