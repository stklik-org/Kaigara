import { create } from "zustand";
import { Load, LoadTimeline, LoadShape, RequestComposition, Scenario, Track, assignTrackColors, withAssignedTrackColors } from "@kaigara/shared-types";
import { coverLoads } from "../timeline/timelineAdapters";

type LoadPatch = Partial<{ startSeconds: number; durationSeconds: number; shape: LoadShape; requests: RequestComposition }>;
type PendingLoad = { trackId: string; load: Load };
export type ComposeViewMode = "visual" | "code";

interface ScenarioStore {
  scenarioName: string;
  timeline: LoadTimeline;
  selectedLoadId: string | null;
  pendingLoad: PendingLoad | null;
  /** Visual/Code toggle for ComposePage — lifted here (rather than local page state) so panels
   *  like the Request Composition generator's "Specify payload in editor" button can jump to the
   *  Code view without prop-drilling a callback down from ComposePage. */
  viewMode: ComposeViewMode;
  setViewMode: (mode: ComposeViewMode) => void;
  /** Wholesale replace — used both by the initial API load and by the JSON editor's onChange. */
  setTimeline: (timeline: LoadTimeline) => void;
  /** Sets the timeline's total length (the "Total length" field in the timeline toolbar). Kept as
   *  a first-class action rather than routed through setTimeline so it reads as the deliberate
   *  authored value it is — clamped only to the schema's `>= 0`, so the user can still set it
   *  shorter than the furthest Load (which then shows the usual "past the end" warning). */
  setTotalDuration: (seconds: number) => void;
  /** Load/RecentFiles picks a Scenario and hands it here; Compose reads whatever's already
   *  loaded instead of always re-instantiating its own default. Tracks the incoming document
   *  left uncoloured get a palette colour here, so the colour is part of the document from the
   *  moment it is opened rather than something the renderer invents each time. */
  loadScenario: (scenario: Scenario) => void;
  selectLoad: (loadId: string | null) => void;
  /** Creates or replaces an unsaved draft load on a track. It is editable/selectable but not
   *  persisted into timeline.tracks until savePendingLoad() is called from the Load Shape panel. */
  stageLoad: (trackId: string, load: Load) => void;
  savePendingLoad: () => void;
  discardPendingLoad: () => void;
  /** Appends a Load to a Track — the click-to-add-on-a-track entry point (see
   *  timeline/shapeVisuals.ts's createLoad). */
  addLoad: (trackId: string, load: Load) => void;
  /** Immutable partial update to one Load (via Load.with) — used by the Load Shape panel's
   *  dropdown/inputs and the Request Composition panel. */
  updateLoad: (trackId: string, loadId: string, patch: LoadPatch) => void;
  removeLoad: (trackId: string, loadId: string) => void;
  renameTrack: (trackId: string, label: string) => void;
  recolorTrack: (trackId: string, color: string) => void;
  removeTrack: (trackId: string) => void;
  /** Moves the Track at `fromIndex` to `toIndex` — drag-and-drop track reordering. */
  reorderTracks: (fromIndex: number, toIndex: number) => void;
  /** Appends a brand-new, empty Track — the "+ Add track" button under the track list. The track
   *  is given a palette colour on the way in (one no sibling is already using), so it carries a
   *  real colour from its first render rather than acquiring one when the document is next
   *  reopened. */
  addTrack: (track: Track) => void;
}

/** Holds the scenario's method-phase timeline while it's being edited — the single source of
 *  truth both TimelineView (drag/resize) and CodeEditorView (JSON text) read from and write to,
 *  so the two views stay live-synced without prop-drilling. Also the hand-off point between the
 *  Load screen (which picks a Scenario) and Compose (which edits its timeline).
 *
 *  Every mutation below reconstructs Track/LoadTimeline via their real constructors (or the
 *  `.with()` convenience methods) rather than object-spreading a class instance — spreading
 *  would silently drop the prototype and produce a plain object that's no longer a real Track/
 *  LoadTimeline (breaking `instanceof` checks and any method call, notably `.toJSON()`). */
export const useScenarioStore = create<ScenarioStore>((set) => ({
  scenarioName: "",
  timeline: LoadTimeline.empty(),
  selectedLoadId: null,
  pendingLoad: null,
  viewMode: "visual",
  setViewMode: (viewMode) => set({ viewMode }),
  setTimeline: (timeline) => set({ timeline }),
  setTotalDuration: (seconds) =>
    set((state) => ({ timeline: state.timeline.with({ totalDurationSeconds: Math.max(0, Math.round(seconds)) }) })),
  loadScenario: (scenario) =>
    set({
      scenarioName: scenario.name,
      timeline: withAssignedTrackColors(scenario.phases.method),
      selectedLoadId: null,
      pendingLoad: null,
    }),
  selectLoad: (loadId) => set({ selectedLoadId: loadId }),
  stageLoad: (trackId, load) => set({ pendingLoad: { trackId, load }, selectedLoadId: load.id }),
  savePendingLoad: () =>
    set((state) => {
      if (!state.pendingLoad) return state;
      const { trackId, load } = state.pendingLoad;
      return {
        timeline: coverLoads(
          state.timeline.with({
            tracks: state.timeline.tracks.map((track) =>
              track.id === trackId ? track.with({ loads: [...track.loads, load] }) : track,
            ),
          }),
        ),
        pendingLoad: null,
      };
    }),
  discardPendingLoad: () =>
    set((state) => ({
      pendingLoad: null,
      selectedLoadId: state.pendingLoad?.load.id === state.selectedLoadId ? null : state.selectedLoadId,
    })),
  addLoad: (trackId, load) =>
    set((state) => ({
      timeline: coverLoads(
        state.timeline.with({
          tracks: state.timeline.tracks.map((track) =>
            track.id === trackId ? track.with({ loads: [...track.loads, load] }) : track,
          ),
        }),
      ),
    })),
  updateLoad: (trackId, loadId, patch) =>
    set((state) => {
      if (state.pendingLoad && state.pendingLoad.trackId === trackId && state.pendingLoad.load.id === loadId) {
        return { pendingLoad: { trackId, load: state.pendingLoad.load.with(patch) } };
      }
      return {
        timeline: coverLoads(
          state.timeline.with({
            tracks: state.timeline.tracks.map((track) =>
              track.id !== trackId
                ? track
                : track.with({ loads: track.loads.map((load) => (load.id === loadId ? load.with(patch) : load)) }),
            ),
          }),
        ),
      };
    }),
  removeLoad: (trackId, loadId) =>
    set((state) => {
      if (state.pendingLoad && state.pendingLoad.trackId === trackId && state.pendingLoad.load.id === loadId) {
        return {
          pendingLoad: null,
          selectedLoadId: state.selectedLoadId === loadId ? null : state.selectedLoadId,
        };
      }
      return {
        timeline: state.timeline.with({
          tracks: state.timeline.tracks.map((track) =>
            track.id !== trackId ? track : track.with({ loads: track.loads.filter((load) => load.id !== loadId) }),
          ),
        }),
        selectedLoadId: state.selectedLoadId === loadId ? null : state.selectedLoadId,
      };
    }),
  renameTrack: (trackId, label) =>
    set((state) => ({
      timeline: state.timeline.with({
        tracks: state.timeline.tracks.map((track) => (track.id === trackId ? track.with({ label }) : track)),
      }),
    })),
  recolorTrack: (trackId, color) =>
    set((state) => ({
      timeline: state.timeline.with({
        tracks: state.timeline.tracks.map((track) => (track.id === trackId ? track.with({ color }) : track)),
      }),
    })),
  removeTrack: (trackId) =>
    set((state) => ({
      timeline: state.timeline.with({
        tracks: state.timeline.tracks.filter((track) => track.id !== trackId),
      }),
      pendingLoad: state.pendingLoad?.trackId === trackId ? null : state.pendingLoad,
      selectedLoadId:
        state.selectedLoadId &&
        (state.timeline.tracks.find((t) => t.id === trackId)?.loads.some((l) => l.id === state.selectedLoadId) ||
          state.pendingLoad?.load.id === state.selectedLoadId)
          ? null
          : state.selectedLoadId,
    })),
  reorderTracks: (fromIndex, toIndex) =>
    set((state) => {
      const tracks = [...state.timeline.tracks];
      if (fromIndex < 0 || fromIndex >= tracks.length || toIndex < 0 || toIndex >= tracks.length) return state;
      const [moved] = tracks.splice(fromIndex, 1);
      tracks.splice(toIndex, 0, moved);
      return { timeline: state.timeline.with({ tracks }) };
    }),
  addTrack: (track) =>
    set((state) => ({
      timeline: state.timeline.with({ tracks: assignTrackColors([...state.timeline.tracks, track]) }),
    })),
}));
