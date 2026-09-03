import type { RunState } from "@kaigara/shared-types";

export const mockRunState: RunState = {
  id: "run-482",
  scenarioId: "component-manufacturer-v1",
  connectionId: "twinsphere",
  engineId: "k6",
  elapsedSeconds: 372, // 06:12
  totalSeconds: 600, // 10:00
  phases: {
    preparation: {
      status: "done",
      startedAt: "13:55:02",
      endedAt: "13:56:18",
      summary: "5000 shells seeded",
    },
    preconditions: {
      status: "done",
      startedAt: "13:56:18",
      endedAt: "13:56:24",
      summary: "2/2 checks passed",
    },
    method: { status: "running", startedAt: "13:56:24" },
    postconditions: {
      status: "pending",
      estimatedStartedAt: "14:03:48",
      estimatedDurationSeconds: 8,
    },
    cleanup: {
      status: "pending",
      estimatedStartedAt: "14:03:56",
      estimatedDurationSeconds: 40,
    },
  },
  activeLoadIds: ["base-1"], // only the whole-duration Base load is active at 06:12
  requestsPerSecondSeries: [320, 355, 340, 410, 425, 460, 448, 478, 470, 495, 512],
  errorLog: [
    { timestamp: "14:02:03", message: "POST /submodels 500 (invalid write)" },
    { timestamp: "14:02:11", message: "GET /shells timeout" },
    { timestamp: "14:02:44", message: "POST /submodels 500 (invalid write)" },
  ],
};
