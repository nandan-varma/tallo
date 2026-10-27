import { cachedSystem, withBreakpoint } from "@tallo/ai";
import { type InferAgentUIMessage, isStepCount, type LanguageModel, ToolLoopAgent } from "ai";
import { fitMessages, TURN_INPUT_TOKENS } from "./context.ts";
import type { JobsPort } from "./jobs.ts";
import { instructions, MAX_READS } from "./prompt.ts";
import { createTools } from "./tools.ts";

/** Hard step ceiling: a model that never answers stops here, with at most this many model calls per message. */
export const MAX_STEPS = 14;
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
  return new ToolLoopAgent({
    model,
    // The prefix (tools, instructions, profile) is the same on every turn: a cache breakpoint lets the provider
    // reuse it. Providers without prompt caching ignore the marker.
    instructions: cachedSystem(instructions({ profile, now })),
    tools: createTools({ jobs, profile }),
    stopWhen: isStepCount(MAX_STEPS),
    // Tool use needs routing, not deliberation: no thinking tokens (the SDK's provider-agnostic switch).
    reasoning: "none",
    maxOutputTokens: STEP_OUTPUT_TOKENS,
    prepareStep: ({ steps, messages }) => {
      const reads = steps
        .flatMap((s) => s.toolCalls)
        .filter((c) => c.toolName === "read_job").length;
      // Input is what the provider bills, and it is re-sent on every step: once a message has spent its input
      // budget, the model answers in text with no tools rather than starting another search.
      const spent = steps.reduce((sum, s) => sum + (s.usage.inputTokens ?? 0), 0);
      return {
        // Old search results are dropped from the request, not from the chat, when a call would be too large.
        // The breakpoint moves to the newest message so each step reads the earlier ones from the cache.
        messages: withBreakpoint(fitMessages(messages)),
        // Going deep is budgeted by the loop, not left to the prompt: after MAX_READS reads the tool is gone.
        activeTools:
          spent >= TURN_INPUT_TOKENS
            ? []
            : reads >= MAX_READS
              ? ["search_jobs"]
              : undefined,
      };
    },
  });
}

export type JobAgent = ReturnType<typeof createJobAgent>;
/** The typed message the browser renders: its tool parts are `tool-search_jobs`, `tool-read_job`, `tool-show_jobs`. */
export type JobAgentMessage = InferAgentUIMessage<JobAgent>;
