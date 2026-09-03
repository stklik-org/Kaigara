import { LoadTimeline, type LoadTimelineData } from "./loadTimeline.ts";
import type { ValidationIssue } from "./loadTimelineValidation.ts";

/** A single configured step in a non-timeline phase (Preparation / Preconditions / Postconditions /
 *  Cleanup). Kept as an ordered list, deliberately not a graph/timeline — see proposal §4.1.
 *  Plain data, not part of the Scenario/Track/Load/LoadShape metamodel — out of scope for now. */
export interface PhaseStep {
  id: string;
  /** Short chip label as shown in the swimlane, e.g. "shells: 5000" or "conformance: SSP-002". */
  label: string;
  kind: string;
  config: Record<string, unknown>;
}

export interface ScenarioPhasesData {
  preparation: PhaseStep[];
  preconditions: PhaseStep[];
  method: LoadTimelineData;
  postconditions: PhaseStep[];
  cleanup: PhaseStep[];
}

export interface ScenarioPhases {
  preparation: PhaseStep[];
  preconditions: PhaseStep[];
  method: LoadTimeline;
  postconditions: PhaseStep[];
  cleanup: PhaseStep[];
}

export interface ScenarioData {
  id: string;
  name: string;
  /** One line saying what this scenario measures — shown on its card in the Load screen's
   *  library. Lives in the document rather than in a separate table so a scenario file dropped
   *  into the library folder describes itself. */
  description?: string;
  connectionId?: string;
  phases: ScenarioPhasesData;
}

export class Scenario {
  id: string;
  name: string;
  description?: string;
  /** Which target this scenario was authored/instantiated against, if any. */
  connectionId?: string;
  phases: ScenarioPhases;

  constructor(params: { id: string; name: string; description?: string; connectionId?: string; phases: ScenarioPhases }) {
    this.id = params.id;
    this.name = params.name;
    this.description = params.description;
    this.connectionId = params.connectionId;
    this.phases = params.phases;
  }

  toJSON(): ScenarioData {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      connectionId: this.connectionId,
      phases: {
        preparation: this.phases.preparation,
        preconditions: this.phases.preconditions,
        method: this.phases.method.toJSON(),
        postconditions: this.phases.postconditions,
        cleanup: this.phases.cleanup,
      },
    };
  }

  static fromJSON(data: ScenarioData): Scenario {
    return new Scenario({
      id: data.id,
      name: data.name,
      description: data.description,
      connectionId: data.connectionId,
      phases: {
        preparation: data.phases.preparation,
        preconditions: data.phases.preconditions,
        method: LoadTimeline.fromJSON(data.phases.method),
        postconditions: data.phases.postconditions,
        cleanup: data.phases.cleanup,
      },
    });
  }
}

/** A reusable, named scenario archetype offered in the Template Library (wireframe 1b),
 *  generalising StressForge's hardcoded profiles (proposal §2.2). */
export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
}

/**
 * One entry of the folder-backed scenario library the backend serves (`GET /api/scenarios`).
 *
 * A file that fails to load is *listed* with its `issues` rather than omitted: the folder is
 * something a user drops files into, and "my scenario isn't in the list" is a far worse answer
 * than "line 42 of your file has an unknown property".
 */
export interface ScenarioLibraryEntry extends ScenarioTemplate {
  /** File name within the library folder, e.g. "public-website.json". */
  file: string;
  /** Why this entry cannot be opened. Absent when it loads cleanly; warnings never appear here. */
  issues?: ValidationIssue[];
}

export interface ScenarioLibraryView {
  /** Absolute path of the folder that was read — the answer to "where do I put my file?". */
  directory: string;
  entries: ScenarioLibraryEntry[];
}
