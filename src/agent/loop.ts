import type { Message, Session } from "../types.js";
import {
  defaultLLMClient,
  type LLMClient,
  type TokenCallback,
} from "../llm/client.js";
import { LLMError } from "../llm/errors.js";
import {
  applyRecap,
  buildRecapPrompt,
  partitionForCompaction,
  shouldCompact,
  truncateCompaction,
} from "../context/compaction.js";
import { executeToolCalls, ToolRegistry } from "../tools/index.js";

/** Callbacks the CLI uses to render live output (spec §3.6). */
export interface AgentCallbacks {
  onToken?: TokenCallback;
  /** Called once per tool call before it runs: `→ name(args)`. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Called once per tool result: condensed `✓`/`✗` line. */
  onToolResult?: (name: string, ok: boolean, summary: string) => void;
  /** Called when compaction begins. */
  onCompacting?: () => void;
}

/** The three terminal states of a single agent turn. */
export type TurnOutcome = "finished" | "cap" | "text";

/** The outcome of a single agent turn. */
export interface TurnResult {
  answer: string;
  /**
   * Which terminal state ended the turn: `finished` (the `finish` tool was
   * called), `cap` (the iteration cap was hit, E10), or `text` (the model
   * emitted plain text with no tool calls, E11).
   */
  kind: TurnOutcome;
  /** True if the turn ended via the `finish` tool. */
  finished: boolean;
}

/**
 * Run one agent turn for a user task (spec §3.2).
 *
 * Appends the user task, then loops: call the LLM → if tool calls, execute and
 * append results; if `finish`, emit the answer; if plain text, treat as the
 * final answer (E11). Applies compaction before each LLM call (spec §3.5).
 *
 * LLM/server errors (E3–E5) propagate up to the caller (the CLI).
 */
export async function runTurn(
  session: Session,
  task: string,
  registry: ToolRegistry,
  callbacks: AgentCallbacks = {},
  signal?: AbortSignal,
  client: LLMClient = defaultLLMClient,
): Promise<TurnResult> {
  const { config } = session;
  session.messages.push({ role: "user", content: task });

  let iterations = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("Turn aborted.");

    // Compaction before each LLM call (spec §3.5).
    await maybeCompact(session, registry, callbacks, signal, client);

    const response = await client.chat({
      config,
      messages: session.messages,
      tools: registry.advertised(),
      signal,
      onToken: callbacks.onToken,
    });

    // Track usage for compaction (spec §3.5).
    session.lastPromptTokens = response.usage?.prompt_tokens ?? null;

    // Append the assistant message to history.
    const assistantMsg: Message = {
      role: "assistant",
      content: response.content || null,
      ...(response.toolCalls.length > 0
        ? { tool_calls: response.toolCalls }
        : {}),
    };
    session.messages.push(assistantMsg);

    // No tool calls: treat text as the final answer (E11).
    if (response.toolCalls.length === 0) {
      return { answer: response.content ?? "", kind: "text", finished: false };
    }

    // Check for a `finish` call (terminal).
    const finishCall = response.toolCalls.find((tc) => tc.name === "finish");
    if (finishCall) {
      const answer = String(finishCall.arguments.answer ?? "");
      // Append a tool result for the finish call to keep history consistent.
      session.messages.push({
        role: "tool",
        tool_call_id: finishCall.id,
        name: "finish",
        content: answer,
      });
      return { answer, kind: "finished", finished: true };
    }

    // Fire onToolCall for each call, then execute.
    for (const tc of response.toolCalls) {
      callbacks.onToolCall?.(tc.name, tc.arguments);
    }

    // Execute the (non-finish) tool calls.
    const results = await executeToolCalls(
      registry,
      response.toolCalls,
      config.maxToolOutputChars,
    );
    for (const result of results) {
      const call = response.toolCalls.find(
        (tc) => tc.id === result.tool_call_id,
      );
      const ok = !result.content.startsWith("Error:");
      const summary = firstLine(result.content);
      callbacks.onToolResult?.(call?.name ?? "tool", ok, summary);
      session.messages.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        name: call?.name,
        content: result.content,
      });
    }

    // Optional iteration cap (E10 / R1).
    iterations++;
    if (config.maxIterations !== null && iterations >= config.maxIterations) {
      return {
        answer:
          `Stopped: reached maxIterations (${config.maxIterations}) without the model ` +
          `calling finish.`,
        kind: "cap",
        finished: false,
      };
    }
  }
}

/**
 * Apply context compaction if the last prompt token count exceeded the
 * threshold. Summarizes older messages via a recap LLM call; falls back to
 * truncation if that call fails (E7).
 */
async function maybeCompact(
  session: Session,
  registry: ToolRegistry,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  client: LLMClient = defaultLLMClient,
): Promise<void> {
  if (!shouldCompact(session.lastPromptTokens, session.config)) return;

  callbacks.onCompacting?.();
  const { system, older, recent } = partitionForCompaction(
    session.messages,
    session.config,
  );
  if (older.length === 0) return;

  try {
    const recap = await client.chat({
      config: session.config,
      messages: buildRecapPrompt(older),
      tools: [],
      signal,
    });
    session.messages = applyRecap(system, recap.content, recent);
  } catch (err) {
    if (err instanceof LLMError) throw err; // connectivity errors abort the turn
    // E7: recap failed for another reason -> fall back to truncation.
    session.messages = truncateCompaction(session.messages, session.config);
  }
}

/** First line of a string, trimmed to a short summary. */
function firstLine(s: string): string {
  const line = s.split("\n", 1)[0].trim();
  return line.length > 80 ? line.slice(0, 77) + "…" : line;
}
