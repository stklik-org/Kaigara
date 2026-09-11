import {
  LoadTimeline,
  Scenario,
  collectLoadTimelineIssues,
  hasErrors,
  parseLoadTimeline,
  type LoadTimelineData,
} from "@kaigara/shared-types";
import { createChatClient, type ChatMessage } from "./chatClient";
import { isLlmConfigReady, type LlmConfig } from "./llmConfig";
import { AssistError, parseReply, timelineDataFrom } from "./replyParsing";
import { scenarioRepairPrompt, scenarioSystemPrompt, scenarioUserPrompt } from "./scenarioPrompt";

/**
 * Description -> `Scenario`, via the configured LLM.
 *
 * The flow is: one completion with the schema-anchored system prompt; validate the reply with the
 * same `loadTimelineValidation` gate the drop zone and backend use; on a validation error, one
 * repair round-trip that feeds the issues back; then wrap the timeline as a `Scenario` for
 * `scenarioStore.loadScenario`. The user always lands in Compose to review — nothing here runs a
 * benchmark.
 */

/** How many bytes of the description to keep as the generated scenario's one-line summary. */
const DESCRIPTION_SUMMARY_LIMIT = 160;

function toScenario(timeline: LoadTimeline, description: string): Scenario {
  const trimmed = description.trim();
  const summary =
    trimmed.length > DESCRIPTION_SUMMARY_LIMIT ? `${trimmed.slice(0, DESCRIPTION_SUMMARY_LIMIT - 1)}…` : trimmed;
  return new Scenario({
    id: `generated-${Date.now()}`,
    name: "Generated scenario",
    description: summary || undefined,
    phases: { preparation: [], preconditions: [], method: timeline, postconditions: [], cleanup: [] },
  });
}

export async function generateScenario(description: string, config: LlmConfig): Promise<Scenario> {
  if (!description.trim()) throw new AssistError("Enter a description first.");
  if (!isLlmConfigReady(config)) {
    throw new AssistError("Set up an AI provider first — open the settings (the gear button).");
  }

  const client = createChatClient(config);
  const messages: ChatMessage[] = [
    { role: "system", content: scenarioSystemPrompt() },
    { role: "user", content: scenarioUserPrompt(description) },
  ];

  const firstReply = await client.complete({ messages });
  const firstParsed = timelineDataFrom(parseReply(firstReply));
  let issues = collectLoadTimelineIssues(firstParsed);

  if (!hasErrors(issues)) {
    return toScenario(parseLoadTimeline(firstParsed as LoadTimelineData), description);
  }

  // One repair attempt: hand the model its own output plus the validator's complaints.
  const repairReply = await client.complete({
    messages: [
      ...messages,
      { role: "assistant", content: firstReply },
      { role: "user", content: scenarioRepairPrompt(issues) },
    ],
  });
  const repairParsed = timelineDataFrom(parseReply(repairReply));
  issues = collectLoadTimelineIssues(repairParsed);

  if (hasErrors(issues)) {
    const summary = issues
      .filter((issue) => issue.severity === "error")
      .slice(0, 3)
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AssistError(
      `The model could not produce a valid scenario, even after a correction attempt (${summary}). Try rephrasing the description or a stronger model.`,
    );
  }
  return toScenario(parseLoadTimeline(repairParsed as LoadTimelineData), description);
}
