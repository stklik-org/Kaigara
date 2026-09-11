import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { MAX_SCENARIO_FILE_BYTES, formatBytes } from "./scenarioFile";

/** The file loader half of the Load screen: a drop target that is also a click/Enter picker.
 *  Everything after "the user picked these files" — reading, parsing, reporting what went wrong —
 *  belongs to the caller, so all failure state lives in one place on the page rather than half
 *  here and half there. */
export function ScenarioDropZone({
  busyWith,
  onFiles,
}: {
  /** Name of the file currently being read, or null when idle. */
  busyWith: string | null;
  onFiles: (files: File[]) => void;
}) {
  // Counter, not a boolean: dragging over a child element fires dragleave on the parent, so a
  // plain flag would flicker the highlight off as the pointer crosses the zone's own text.
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = busyWith !== null;

  // A file dropped anywhere *outside* the zone would otherwise make the browser navigate away to
  // it, silently discarding whatever is loaded. Swallow those drops app-wide while this screen is
  // mounted; the zone's own handler stops propagation before this sees them.
  useEffect(() => {
    const swallow = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  function accept(files: FileList | null) {
    if (files && files.length > 0) onFiles(Array.from(files));
  }

  function browse() {
    fileInputRef.current?.click();
  }

  return (
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
      onDragEnter={(event: ReactDragEvent) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDragOver={(event: ReactDragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event: ReactDragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragActive(false);
        accept(event.dataTransfer.files);
      }}
      className={`mt-2 flex cursor-pointer flex-col items-center justify-center gap-2 p-10 text-center transition-colors ${
        dragActive ? "border-accent bg-accent-bg" : "hover:border-border-strong hover:bg-surface-sunken"
      }`}
    >
      <div className="text-sm font-medium text-ink">
        {busy ? `Reading ${busyWith}…` : dragActive ? "Release to load" : "Drop a scenario file here"}
      </div>
      <div className="text-xs text-ink-muted">
        JSON — a full scenario, or a bare method timeline (max {formatBytes(MAX_SCENARIO_FILE_BYTES)})
      </div>
      <Button
        variant="secondary"
        className="mt-1"
        disabled={busy}
        onClick={(event) => {
          // The panel itself is the picker trigger; without this the click would bubble up and
          // open the dialog a second time.
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
          accept(event.target.files);
          // Reset so re-picking the same file (e.g. after fixing it on disk) still fires.
          event.target.value = "";
        }}
      />
    </Panel>
  );
}
