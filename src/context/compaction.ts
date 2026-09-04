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
 * Build the message array for a summarization (recap) LLM call.
 */
export function buildRecapPrompt(older: Message[]): Message[] {
  const transcript = older
    .map((m) => {
      const role = m.role;
      const content = m.content ?? "";
      if (role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls
          .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`)
          .join(", ");
        return `assistant: [tool calls: ${calls}]${content ? " " + content : ""}`;
      }
      if (role === "tool") return `tool result: ${content}`;
      return `${role}: ${content}`;
    })
    .join("\n");

  return [
    {
      role: "user",
      content:
        "Summarize the work done so far in this coding session, including files " +
        "changed, commands run, and any open issues, in a few concise bullet points.\n\n" +
        `Conversation so far:\n${transcript}`,
    },
  ];
}

/**
 * Rebuild the message array after a successful recap:
 * [system…, recap-as-user-message, …recent].
 */
export function applyRecap(
  system: Message[],
  recap: string,
  recent: Message[],
): Message[] {
  return [
    ...system,
    { role: "user", content: `Summary of prior work:\n${recap}` },
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
