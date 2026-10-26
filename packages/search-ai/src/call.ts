import {
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from "ai";
import type { z } from "zod";
import type { Tokens } from "./types.ts";

export type Meter = {
  tokens: { fast: Tokens; smart: Tokens };
  retries: number;
};

export function newMeter(): Meter {
  return {
    tokens: { fast: { input: 0, output: 0 }, smart: { input: 0, output: 0 } },
    retries: 0,
  };
}

type Role = keyof Meter["tokens"];

type StructuredCall<S extends z.ZodType> = {
  role: Role;
  model: LanguageModel;
  schema: S;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  meter: Meter;
};

// Empty content is an error. Reasoning models can spend the whole budget on reasoning, so the one retry
// doubles maxOutputTokens. Any other failure is thrown as is.
export async function structured<S extends z.ZodType>(
  call: StructuredCall<S>,
): Promise<z.infer<S>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const maxOutputTokens = call.maxOutputTokens * 2 ** attempt;
    try {
      const result = await generateText({
        model: call.model,
        system: call.system,
        prompt: call.prompt,
        maxOutputTokens,
        output: Output.object({ schema: call.schema }),
      });
      const tokens = call.meter.tokens[call.role];
      tokens.input += result.usage.inputTokens ?? 0;
      tokens.output += result.usage.outputTokens ?? 0;
      if (result.output === undefined || result.output === null) {
        throw new NoOutputGeneratedError();
      }
      return result.output as z.infer<S>;
    } catch (error) {
      if (attempt === 0 && isEmptyContent(error)) {
        call.meter.retries += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

function isEmptyContent(error: unknown): boolean {
  if (NoOutputGeneratedError.isInstance(error)) return true;
  if (NoObjectGeneratedError.isInstance(error)) return (error.text ?? "").trim() === "";
  return false;
}
