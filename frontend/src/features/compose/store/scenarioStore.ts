import { create } from "zustand";
import {
  Load,
  LoadShape,
  LoadTimeline,
  RequestComposition,
  Scenario,
  Track,
  assignTrackColors,
  withAssignedTrackColors,
} from "@kaigara/shared-types";
import { createTrack } from "../timeline/modelFactories";
import { coverLoads } from "../timeline/timelineAdapters";
import { readTimelineDraft, writeTimelineDraft } from "./timelinePersistence";

type LoadPatch = Partial<{
  startSeconds: number;
  durationSeconds: number;
  shape: LoadShape;
  requests: RequestComposition;
}>;
type PendingLoad = { trackId: string; load: Load };
export type ComposeViewMode = "visual" | "code";

/** What `initializeTimeline` names a from-scratch scenario, and the exact string ComposePage
 *  checks for before a download to decide whether to ask for a real name first — shared so the
 *  two can't drift apart into two different spellings of "not named yet". */
export const DEFAULT_SCENARIO_NAME = "Untitled scenario";

/** Replaces one Track in `timeline`, leaving the others untouched.
 *
 *  Every mutation below goes through this (or {@link mapLoad}) rather than rebuilding the track
 *  list inline, so none of them can accidentally object-spread a metamodel instance: `{...track}`
 *  drops the prototype and yields a plain object whose `toJSON()`/`rateAt()` are gone. `.with()`
 *  is the only safe way to change a field. */
function mapTrack(timeline: LoadTimeline, trackId: string, change: (track: Track) => Track): LoadTimeline {
  return timeline.with({
    tracks: timeline.tracks.map((track) => (track.id === trackId ? change(track) : track)),
  });
}

/** {@link mapTrack} one level deeper: replaces one Load on one Track. */
function mapLoad(
  timeline: LoadTimeline,
  trackId: string,
  loadId: string,
  change: (load: Load) => Load,
): LoadTimeline {
  return mapTrack(timeline, trackId, (track) =>
    track.with({ loads: track.loads.map((load) => (load.id === loadId ? change(load) : load)) }),
  );
}

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
  /** The Load screen picks a Scenario and hands it here; Compose reads whatever's already loaded
   *  instead of always re-instantiating its own default. Tracks that arrive uncoloured get a
   *  palette colour here, so the colour is part of the document from the moment it is opened
   *  rather than something the renderer invents on each render. */
  loadScenario: (scenario: Scenario) => void;
  /** Starts a from-scratch timeline, seeded with one empty Track (the same `createTrack()` the
   *  canvas's own "+ Add track" uses) so the canvas doesn't open on a literal blank grid — for
   *  "build one up in Compose" rather than opening something from the Load screen. `scenarioName`
   *  is what ComposePage's empty-state gate checks (not `timeline.tracks.length`, which a
   *  genuinely-loaded scenario can happen to be zero on too), so this exists to give that flag a
   *  value distinct from the store's true initial "nothing chosen yet" state. */
  initializeTimeline: () => void;
  /** Renames the open scenario — the header's editable name field, and how the Download-while-
   *  unnamed prompt turns the name the user just typed into the actual document title rather than
   *  a one-off filename. A no-op for blank input; the field itself is the one place that decides
   *  whether an edit is worth committing. */
  setScenarioName: (name: string) => void;
  selectLoad: (loadId: string | null) => void;
  /** Creates or replaces an unsaved draft Load on a track. It is editable and selectable but not
   *  part of `timeline.tracks` until `savePendingLoad()` is called. */
  stageLoad: (trackId: string, load: Load) => void;
  /** Commits the draft Load into the document. Called explicitly from the Load Shape panel's Save
   *  button, and implicitly by the parameter dialog when a request is added to a draft — see the
   *  comment there for why an added request is taken as intent to keep the Load. */
  savePendingLoad: () => void;
  discardPendingLoad: () => void;
  /** Appends a Load to a Track — the click-to-add-on-a-track entry point. */
  addLoad: (trackId: string, load: Load) => void;
  /** Immutable partial update to one Load, used by the Load Shape and Request Composition panels. */
  updateLoad: (trackId: string, loadId: string, patch: LoadPatch) => void;
  removeLoad: (trackId: string, loadId: string) => void;
  renameTrack: (trackId: string, label: string) => void;
  recolorTrack: (trackId: string, color: string) => void;
  removeTrack: (trackId: string) => void;
  /** Moves the Track at `fromIndex` to `toIndex` — drag-and-drop track reordering. */
  reorderTracks: (fromIndex: number, toIndex: number) => void;
  /** Appends a brand-new Track. It is given a palette colour no sibling is using on the way in, so
   *  it carries a real colour from its first render rather than acquiring one when the document is
   *  next reopened. */
  addTrack: (track: Track) => void;
}

/** How long to coalesce edits before writing the draft to localStorage — long enough that a drag
 *  firing dozens of updates persists once, short enough that a reload right after an edit keeps
 *  it. Mirrors CodeEditorView's own debounce. */
const PERSIST_DEBOUNCE_MS = 400;

/** The Compose timeline autosaves to localStorage as it is edited (see timelinePersistence.ts),
 *  so a reload or a return visit resumes on the same document. The store boots from that draft
 *  here — synchronously, so the first render already has it and there is no empty-state flash and
 *  no restoring effect to write. `null` when nothing is stored or it no longer parses. */
const restoredDraft = readTimelineDraft();

/** Holds the scenario's method-phase timeline while it's being edited — the single source of truth
 *  both TimelineView (drag/resize) and CodeEditorView (JSON text) read from and write to, so the
 *  two views stay live-synced without prop-drilling. Also the hand-off point between the Load
 *  screen (which picks a Scenario) and Compose (which edits its timeline). */
export const useScenarioStore = create<ScenarioStore>((set) => ({
  scenarioName: restoredDraft?.name ?? "",
  timeline: restoredDraft?.timeline ?? LoadTimeline.empty(),
  selectedLoadId: null,
  pendingLoad: null,
  viewMode: "visual",

  setViewMode: (viewMode) => set({ viewMode }),
  setTimeline: (timeline) => set({ timeline }),

  setTotalDuration: (seconds) =>
    set((state) => ({
      timeline: state.timeline.with({ totalDurationSeconds: Math.max(0, Math.round(seconds)) }),
    })),

  loadScenario: (scenario) =>
    set({
      scenarioName: scenario.name,
      timeline: withAssignedTrackColors(scenario.phases.method),
      selectedLoadId: null,
      pendingLoad: null,
    }),

  initializeTimeline: () =>
    set({
      scenarioName: DEFAULT_SCENARIO_NAME,
      timeline: LoadTimeline.empty().with({ tracks: assignTrackColors([createTrack()]) }),
      selectedLoadId: null,
      pendingLoad: null,
    }),

  setScenarioName: (name) => {
    const trimmed = name.trim();
    if (trimmed) set({ scenarioName: trimmed });
  },

  selectLoad: (loadId) => set({ selectedLoadId: loadId }),

  stageLoad: (trackId, load) => set({ pendingLoad: { trackId, load }, selectedLoadId: load.id }),

  savePendingLoad: () =>
    set((state) => {
      if (!state.pendingLoad) return state;
      const { trackId, load } = state.pendingLoad;
      return {
        timeline: coverLoads(
          mapTrack(state.timeline, trackId, (track) => track.with({ loads: [...track.loads, load] })),
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
        mapTrack(state.timeline, trackId, (track) => track.with({ loads: [...track.loads, load] })),
      ),
    })),

  updateLoad: (trackId, loadId, patch) =>
    set((state) => {
      // A draft Load lives outside the document until it is saved, so an edit to it must not go
      // anywhere near `timeline`.
      if (state.pendingLoad?.trackId === trackId && state.pendingLoad.load.id === loadId) {
        return { pendingLoad: { trackId, load: state.pendingLoad.load.with(patch) } };
      }
      return { timeline: coverLoads(mapLoad(state.timeline, trackId, loadId, (load) => load.with(patch))) };
    }),

  removeLoad: (trackId, loadId) =>
    set((state) => {
      const selectedLoadId = state.selectedLoadId === loadId ? null : state.selectedLoadId;
      if (state.pendingLoad?.trackId === trackId && state.pendingLoad.load.id === loadId) {
        return { pendingLoad: null, selectedLoadId };
      }
      return {
        timeline: mapTrack(state.timeline, trackId, (track) =>
          track.with({ loads: track.loads.filter((load) => load.id !== loadId) }),
        ),
        selectedLoadId,
      };
    }),

  renameTrack: (trackId, label) =>
    set((state) => ({ timeline: mapTrack(state.timeline, trackId, (track) => track.with({ label })) })),

  recolorTrack: (trackId, color) =>
    set((state) => ({ timeline: mapTrack(state.timeline, trackId, (track) => track.with({ color })) })),

  removeTrack: (trackId) =>
    set((state) => {
      // The selection has to be dropped if it pointed into this track — either at one of its saved
      // Loads or at a draft staged on it.
      const removed = state.timeline.tracks.find((track) => track.id === trackId);
      const selectionWasHere =
        state.selectedLoadId !== null &&
        (removed?.loads.some((load) => load.id === state.selectedLoadId) === true ||
          state.pendingLoad?.load.id === state.selectedLoadId);

      return {
        timeline: state.timeline.with({
          tracks: state.timeline.tracks.filter((track) => track.id !== trackId),
        }),
        pendingLoad: state.pendingLoad?.trackId === trackId ? null : state.pendingLoad,
        selectedLoadId: selectionWasHere ? null : state.selectedLoadId,
      };
    }),

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

// Mirror every change to the open document back into localStorage, debounced. Only once a
// scenario is actually open (`scenarioName` set by `loadScenario` or `initializeTimeline`) — an
// untouched store is not a draft worth restoring, and writing one would make "/" jump to Compose
// on a first-ever visit.
let persistTimer: ReturnType<typeof setTimeout> | undefined;
useScenarioStore.subscribe((state, previous) => {
  if (state.timeline === previous.timeline && state.scenarioName === previous.scenarioName) return;
  if (!state.scenarioName) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => writeTimelineDraft(state.scenarioName, state.timeline), PERSIST_DEBOUNCE_MS);
});
