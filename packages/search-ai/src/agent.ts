import { type InferAgentUIMessage, isStepCount, type LanguageModel, ToolLoopAgent } from "ai";
import type { JobsPort } from "./jobs.ts";
import { instructions, MAX_READS } from "./prompt.ts";
import { createTools } from "./tools.ts";

const MAX_STEPS = 14;

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
    instructions: instructions({ profile, now }),
    tools: createTools({ jobs, profile }),
    stopWhen: isStepCount(MAX_STEPS),
    // Tool use needs routing, not deliberation: no thinking tokens (the SDK's provider-agnostic switch).
    reasoning: "none",
    maxOutputTokens: 2_000,
    // Going deep is budgeted by the loop, not left to the prompt: after MAX_READS reads the tool is gone.
    prepareStep: ({ steps }) => {
      const reads = steps
        .flatMap((s) => s.toolCalls)
        .filter((c) => c.toolName === "read_job").length;
      return reads >= MAX_READS ? { activeTools: ["search_jobs"] } : undefined;
    },
  });
}

export type JobAgent = ReturnType<typeof createJobAgent>;
/** The typed message the browser renders: its tool parts are `tool-search_jobs`, `tool-read_job`, `tool-show_jobs`. */
export type JobAgentMessage = InferAgentUIMessage<JobAgent>;
