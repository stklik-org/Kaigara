import {
  LoadTimeline,
  collectLoadTimelineIssues,
  hasErrors,
  parseLoadTimeline,
  type LoadTimelineData,
} from "@kaigara/shared-types";
import { createChatClient, type ChatMessage } from "./chatClient";
import { isLlmConfigReady, type LlmConfig } from "./llmConfig";
import { AssistError, parseReply, timelineDataFrom } from "./replyParsing";
import { editSystemPrompt, editUserPrompt, scenarioRepairPrompt } from "./scenarioPrompt";

/**
 * `(currentTimeline, instruction) -> editedTimeline`, via the configured LLM — the Compose "edit
 * with AI" button.
 *
 * The current document is sent as JSON in the prompt and the model returns the whole updated
 * document (not a diff — the metamodel has no patch format, and a full replacement round-trips
 * through the same `loadTimelineValidation` gate as a hand-edit in the Code view). One repair
 * round-trip on a validation failure, same as `generateScenario`. The caller replaces the store's
 * timeline with the result; the user sees the change on the canvas and can undo by editing back.
 */
export async function editTimeline(
  current: LoadTimeline,
  instruction: string,
  config: LlmConfig,
): Promise<LoadTimeline> {
  if (!instruction.trim()) throw new AssistError("Describe the change first.");
  if (!isLlmConfigReady(config)) {
    throw new AssistError("Set up an AI provider first — open the settings (the gear button).");
  }

  const client = createChatClient(config);
  const currentJson = JSON.stringify(current.toJSON(), null, 2);
  const messages: ChatMessage[] = [
    { role: "system", content: editSystemPrompt() },
    { role: "user", content: editUserPrompt(currentJson, instruction) },
  ];

  const firstReply = await client.complete({ messages });
  let parsed = timelineDataFrom(parseReply(firstReply));
  let issues = collectLoadTimelineIssues(parsed);
  if (!hasErrors(issues)) return parseLoadTimeline(parsed as LoadTimelineData);

  const repairReply = await client.complete({
    messages: [
      ...messages,
      { role: "assistant", content: firstReply },
      { role: "user", content: scenarioRepairPrompt(issues) },
    ],
  });
  parsed = timelineDataFrom(parseReply(repairReply));
  issues = collectLoadTimelineIssues(parsed);

  if (hasErrors(issues)) {
    const summary = issues
      .filter((issue) => issue.severity === "error")
      .slice(0, 3)
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AssistError(
      `The model's edit did not produce a valid timeline, even after a correction attempt (${summary}). Try a simpler instruction or a stronger model.`,
    );
  }
  return parseLoadTimeline(parsed as LoadTimelineData);
}
