import type { EngineId } from "./engine.ts";

export type PhaseName = "preparation" | "preconditions" | "method" | "postconditions" | "cleanup";

/** `skipped` is distinct from `done`: the phase did not run at all. The orchestrator currently
 *  executes only the `method` phase, and reporting the other four as "done" would claim seeding
 *  and correctness checks had passed when nothing ran. */
export type PhaseRunStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PhaseExecution {
  status: PhaseRunStatus;
  startedAt?: string;
  endedAt?: string;
  /** Only meaningful while status is "pending" (not yet reached) — wireframe 1d right lane. */
  estimatedStartedAt?: string;
  estimatedDurationSeconds?: number;
  /** One-line human summary, e.g. "5000 shells seeded" or "2/2 checks passed". */
  summary?: string;
}

export interface ErrorLogEntry {
  timestamp: string;
  message: string;
}

export interface RunState {
  id: string;
  scenarioId: string;
  connectionId: string;
  /** Which engine adapter is executing this run — see engine.ts. Only "k6" is implemented. */
  engineId: EngineId;
  elapsedSeconds: number;
  totalSeconds: number;
  phases: Record<PhaseName, PhaseExecution>;
  activeLoadIds: string[];
  requestsPerSecondSeries: number[];
  errorLog: ErrorLogEntry[];
}
