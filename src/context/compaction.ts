import type { Config, Message } from "../types.js";

/**
 * Determine whether compaction should run given the last reported prompt token
 * count (spec §3.5).
 */
export function shouldCompact(
  promptTokens: number | null | undefined,
  config: Config,
): boolean {
  if (promptTokens === null || promptTokens === undefined) return false;
  return promptTokens > config.compactThreshold * config.maxContext;
}

/**
 * Choose the boundary index such that messages[boundary..] are the "recent"
 * messages to keep verbatim. Keeps the most recent `keep` messages, then walks
 * the boundary backward so that no assistant `tool_calls` message is separated
 * from its `tool` result messages.
 *
 * Returns the index of the first message to keep.
 */
export function findKeepBoundary(messages: Message[], keep: number): number {
  const n = messages.length;
  if (n <= keep) return 0;
  let boundary = n - keep;
  // Walk backward while the message just before the boundary is a `tool` result
  // (i.e. it belongs to a tool_calls group that starts earlier).
  while (boundary > 0 && messages[boundary].role === "tool") {
    boundary--;
  }
  // Also ensure we don't split an assistant tool_calls message from its results:
  // if the message at boundary-1 is an assistant with tool_calls, include it.
  while (
    boundary > 0 &&
    messages[boundary - 1].role === "assistant" &&
    (messages[boundary - 1].tool_calls?.length ?? 0) > 0
  ) {
    boundary--;
  }
  return boundary;
}

/**
 * Split messages into [system, older, recent] for compaction.
 * - system: leading system messages.
 * - recent: messages from the keep boundary onward.
 * - older: everything in between (to be summarized).
 */
export function partitionForCompaction(
  messages: Message[],
  config: Config,
): { system: Message[]; older: Message[]; recent: Message[] } {
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd].role === "system")
    sysEnd++;
  const system = messages.slice(0, sysEnd);
  const boundary = findKeepBoundary(messages, config.compactKeepMessages);
  const recent = messages.slice(boundary);
  const older = messages.slice(sysEnd, boundary);
  return { system, older, recent };
}

/**
 * Build the message array for the recap (summarization) LLM call
 * (spec v0.2.0 §3.3).
 *
 * The recap request is the existing conversation plus ONE appended `user`
 * instruction — NOT a fresh transcript. This keeps the request's prefix
 * identical to the cached main conversation, so a prefix-caching backend
 * (e.g. llama.cpp `llama-server` with `cache_prompt`) only prefills the short
 * instruction. The instruction is count-based: it tells the model to summarize
 * everything before the most recent `compactKeepMessages` messages, which are
 * retained verbatim and must be excluded from the summary.
 *
 * The appended instruction is transient: callers must NOT add it to
 * `session.messages`.
 */
export function buildRecapRequest(
  messages: Message[],
  config: Config,
): Message[] {
  const keep = config.compactKeepMessages;
  return [
    ...messages,
    {
      role: "user",
      content:
        "Summarize the work done so far in this coding session, covering only " +
        "the earlier part of the conversation — everything before the most " +
        `recent ${keep} messages, which are retained separately and must be ` +
        "excluded from the summary. Include files changed, commands run, and " +
        "any open issues, in a few concise bullet points. Do not call any " +
        "tools; respond with the summary text only.",
    },
  ];
}

/**
 * Rebuild the message array after a successful recap (spec v0.2.0 §3.4):
 * [system…, recap-as-system-message, …recent].
 *
 * The recap is a `system` message placed mid-conversation; the system prompt
 * and the recent tail are carried over verbatim (same objects, same order).
 */
export function applyRecap(
  system: Message[],
  recap: string,
  recent: Message[],
): Message[] {
  return [
    ...system,
    { role: "system", content: `Summary of prior work:\n${recap}` },
    ...recent,
  ];
}

/**
 * Fallback compaction via truncation (E7): drop the oldest non-system,
 * non-recent messages, keeping tool-call/result pairs intact.
 */
export function truncateCompaction(
  messages: Message[],
  config: Config,
): Message[] {
  const { system, recent } = partitionForCompaction(messages, config);
  return [...system, ...recent];
}
