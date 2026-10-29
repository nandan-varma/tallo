import type { ModelMessage, SystemModelMessage } from "ai";

/**
 * Anthropic's prompt-cache marker, passed through the AI SDK's provider options. The provider reads it on a system
 * message (caches tools and system text before it), or on the last part of a message (caches everything up to it).
 * Providers that do not know the key ignore it.
 */
const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

/** The stable prefix of a request (instructions, profile): cached across turns when the provider supports it. */
export function cachedSystem(content: string): SystemModelMessage {
  return { role: "system", content, providerOptions: EPHEMERAL };
}

/**
 * Moves the cache breakpoint to the last message, so each step of a turn reads the earlier steps from the cache.
 * Earlier breakpoints are removed first: Anthropic allows four per request and ignores the rest. Returns copies.
 */
export function withBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const unmarked = messages.map((message) => {
    const { anthropic: _drop, ...rest } = message.providerOptions ?? {};
    return { ...message, providerOptions: rest };
  });
  const last = unmarked[unmarked.length - 1] as ModelMessage;
  return [
    ...unmarked.slice(0, -1),
    { ...last, providerOptions: { ...last.providerOptions, ...EPHEMERAL } },
  ];
}
