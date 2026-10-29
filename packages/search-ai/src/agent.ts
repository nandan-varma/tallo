import { cachedSystem, withBreakpoint } from "@tallo/ai";
import { type InferAgentUIMessage, isStepCount, type LanguageModel, ToolLoopAgent } from "ai";
import { fitMessages, OMITTED_RESULT, TURN_INPUT_TOKENS } from "./context.ts";
import type { JobsPort } from "./jobs.ts";
import { instructions } from "./prompt.ts";
import { createTools } from "./tools.ts";

/** Hard step ceiling: a model that never answers stops here, with at most this many model calls per message. */
export const MAX_STEPS = 24;
/** Visible answer per model call. Tool calls are short; a reply is at most three sentences. */
export const STEP_OUTPUT_TOKENS = 2_000;

export function createJobAgent({
  model,
  jobs,
  profile,
  now = new Date(),
}: {
  model: LanguageModel;
  jobs: JobsPort;
  profile: string;
  now?: Date;
}) {
  const reviewedViews = new Set<string>();
  return new ToolLoopAgent({
    model,
    // The prefix (tools, instructions, profile) is the same on every turn: a cache breakpoint lets the provider
    // reuse it. Providers without prompt caching ignore the marker.
    instructions: cachedSystem(instructions({ profile, now })),
    tools: createTools({ jobs, profile, reviewedViews }),
    stopWhen: isStepCount(MAX_STEPS),
    // Tool use needs routing, not deliberation: no thinking tokens (the SDK's provider-agnostic switch).
    reasoning: "none",
    maxOutputTokens: STEP_OUTPUT_TOKENS,
    prepareStep: ({ steps, messages }) => {
      // Only views delivered in completed earlier steps can support publication. A parallel
      // read+publish call cannot claim the model inspected evidence it has not received yet.
      const fitted = fitMessages(messages);
      const completedViews = new Map<string, string>();
      for (const step of steps)
        for (const result of step.toolResults) {
          const output = result.output;
          if (
            result.toolName === "read_job" &&
            output &&
            typeof output === "object" &&
            "found" in output &&
            output.found === true &&
            "view" in output &&
            typeof output.view === "string"
          )
            completedViews.set(result.toolCallId, output.view);
        }
      // Context fitting may omit even a completed read. Admit its evidence only when the actual
      // model request includes that text; previously delivered views stay admissible this turn.
      for (const message of fitted)
        if (message.role === "tool")
          for (const part of message.content) {
            if (
              part.type === "tool-result" &&
              part.toolName === "read_job" &&
              part.output.type === "text" &&
              part.output.value !== OMITTED_RESULT
            ) {
              const view = completedViews.get(part.toolCallId);
              if (view) reviewedViews.add(view);
            }
          }
      // Input is what the provider bills, and it is re-sent on every step: once a message has spent its input
      // budget, only publication remains available rather than starting another search.
      const spent = steps.reduce((sum, s) => sum + (s.usage.inputTokens ?? 0), 0);
      const published = steps.some((step) =>
        step.toolResults.some((result) => result.toolName === "publish_jobs"),
      );
      const finalize = spent >= TURN_INPUT_TOKENS || steps.length >= MAX_STEPS - 2;
      return {
        // Old search results are dropped from the request, not from the chat, when a call would be too large.
        // The breakpoint moves to the newest message so each step reads the earlier ones from the cache.
        messages: withBreakpoint(fitted),
        // At the input ceiling only finalization remains; read_job enforces the distinct-read cap.
        activeTools: finalize ? (published ? [] : ["publish_jobs"]) : undefined,
        // Reserve the last two steps for a shortlist (possibly empty) and an honest final answer.
        toolChoice: finalize && !published ? { type: "tool", toolName: "publish_jobs" } : undefined,
      };
    },
  });
}

export type JobAgent = ReturnType<typeof createJobAgent>;
/** The typed message the browser renders: its tool parts are `tool-search_jobs`, `tool-read_job`, `tool-publish_jobs`. */
export type JobAgentMessage = InferAgentUIMessage<JobAgent>;
