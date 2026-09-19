import { create } from "zustand";

/**
 * Whether a benchmark is currently executing, read by `AppShell`'s stage nav so it can refuse to
 * navigate away from a live run — a run keeps issuing load against a real server regardless of
 * which screen is open, so leaving mid-run is easy to do by accident and hard to notice you did.
 *
 * `RunPage` is the only writer: it already tracks a run's live status via SSE (`RunView.status`),
 * so this just mirrors that one boolean out to a place the nav (which knows nothing about runs)
 * can read. Kept as its own tiny store rather than added to `scenarioStore` — this is runtime
 * activity, not part of the authored scenario document.
 */
interface ActiveRunState {
  isRunning: boolean;
  setIsRunning: (isRunning: boolean) => void;
}

export const useActiveRunStore = create<ActiveRunState>((set) => ({
  isRunning: false,
  setIsRunning: (isRunning) => set({ isRunning }),
}));
