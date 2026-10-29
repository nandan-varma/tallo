import type { ModelMessage } from "ai";

/**
 * Input budgets for one assistant message. Estimates use four characters per token (a heuristic; the provider's
 * usage numbers are the truth and are what the turn budget reads).
 */
/** Messages sent in one model call. Above it, the oldest search results are left out of the request. */
export const STEP_INPUT_TOKENS = 24_000;
/** Input tokens summed over all model calls of one message. Above it, the agent may only answer in text. */
export const TURN_INPUT_TOKENS = 160_000;
/** Messages of conversation history the model sees; older ones are dropped at a user message. */
export const HISTORY_MESSAGES = 40;

export const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / 4);

export const OMITTED_RESULT =
  "(Earlier search results, left out to keep this request small. Search again if you need them.)";

/**
 * Keeps one model call under `budget` estimated tokens by replacing the oldest tool results with a marker. The
 * newest tool result is never touched, so the model always sees what it just asked for. Returns copies.
 */
export function fitMessages(messages: ModelMessage[], budget = STEP_INPUT_TOKENS): ModelMessage[] {
  if (estimateTokens(messages) <= budget) return messages;
  const toolMessages = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const newest = toolMessages[toolMessages.length - 1];
  let fitted = messages;
  for (const index of toolMessages) {
    if (index === newest) break;
    fitted = fitted.map((message, i) => (i === index ? omitResults(message) : message));
    if (estimateTokens(fitted) <= budget) break;
  }
  return fitted;
}

function omitResults(message: ModelMessage): ModelMessage {
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "tool-result"
        ? { ...part, output: { type: "text", value: OMITTED_RESULT } }
        : part,
    ),
  };
}

/** The last `max` messages, starting at a user message, so the model never sees an answer without its question. */
export function recentTurns<T extends { role: string }>(
  messages: T[],
  max = HISTORY_MESSAGES,
): T[] {
  const tail = messages.slice(-max);
  const start = tail.findIndex((m) => m.role === "user");
  return start <= 0 ? tail : tail.slice(start);
}
