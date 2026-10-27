import { type LanguageModel, wrapLanguageModel } from "ai";
import { type SpendLedger, utcDay } from "./budget.ts";

/** The provider's usage as the AI SDK's language model spec reports it (`inputTokens.cacheRead` etc.). */
export interface ProviderUsage {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
}

/** Tokens one request spent, summed over its model calls (steps). */
export interface Meter {
  /** Model calls, one per step. */
  steps: number;
  /** Input tokens, cached ones included. */
  input: number;
  /** Input tokens read from the provider's prompt cache. */
  cached: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  output: number;
  /** Input plus output: what the daily ledger counts. */
  readonly total: number;
  add(usage: ProviderUsage | undefined): void;
}

export function meter(): Meter {
  const m: Meter = {
    steps: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    get total() {
      return m.input + m.output;
    },
    add(usage) {
      m.steps += 1;
      m.input += usage?.inputTokens?.total ?? 0;
      m.cached += usage?.inputTokens?.cacheRead ?? 0;
      m.cacheWrite += usage?.inputTokens?.cacheWrite ?? 0;
      m.output += usage?.outputTokens?.total ?? 0;
    },
  };
  return m;
}

/**
 * Wraps a model with AI SDK middleware that adds each call's usage to `m`. Every call goes through it, the
 * agent's steps and the single-shot resume calls alike, so one meter covers a whole request.
 */
export function meteredModel(model: Exclude<LanguageModel, string>, m: Meter): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        m.add(result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "finish") m.add(part.usage);
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
}

export const modelIdOf = (model: LanguageModel): string =>
  typeof model === "string" ? model : model.modelId;

/**
 * One structured log line per request: the feature, the model and what it spent. Cache reads show whether the
 * provider's prompt cache is working (cached tokens are a part of input, not an addition to it).
 */
export function logUsage(feature: string, model: LanguageModel, m: Meter): void {
  console.log(
    JSON.stringify({
      event: "ai.usage",
      feature,
      model: modelIdOf(model),
      steps: m.steps,
      input: m.input,
      cached: m.cached,
      cacheWrite: m.cacheWrite,
      output: m.output,
    }),
  );
}

/** End of a request: logs its usage and adds its tokens to today's ledger. Call once, when the request ends. */
export async function settle(
  feature: string,
  model: LanguageModel,
  m: Meter,
  ledger: SpendLedger,
  now: Date = new Date(),
): Promise<void> {
  if (m.steps === 0) return;
  logUsage(feature, model, m);
  if (m.total > 0) await ledger.add(utcDay(now), m.total);
}
