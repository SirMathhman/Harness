import type { Message, Session } from "../types.js";
import type { HookOutcome } from "../hooks/index.js";
import {
  defaultLLMClient,
  type LLMClient,
  type ReasoningCallback,
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
import {
  executeToolCalls,
  ToolRegistry,
  type ToolLifecycle,
} from "../tools/index.js";

/** Callbacks the CLI uses to render live output (spec §3.6). */
export interface AgentCallbacks {
  onToken?: TokenCallback;
  /** Called for each reasoning/thinking token as it streams in. */
  onReasoning?: ReasoningCallback;
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

  // turn:start (hooks §3.1): advisory output lands before the first LLM call.
  appendAdvisory(session, session.hooks.dispatch("turn:start", ctxOf(session)));

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
      onReasoning: callbacks.onReasoning,
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

    // Check for a `finish` call (terminal unless a `turn:end` hook rejects it).
    const finishCall = response.toolCalls.find((tc) => tc.name === "finish");
    if (finishCall) {
      const outcome = session.hooks.dispatch("turn:end", ctxOf(session));
      if (outcome.block === null) {
        const answer = String(finishCall.arguments.answer ?? "");
        // Append a tool result for the finish call to keep history consistent.
        session.messages.push({
          role: "tool",
          tool_call_id: finishCall.id,
          name: "finish",
          content: answer,
        });
        appendAdvisory(session, outcome);
        return { answer, kind: "finished", finished: true };
      }
      // hooks §3.5: `finish` is rejected. The reason becomes its tool result
      // and the loop continues, so the model can fix the problem and retry.
      session.messages.push({
        role: "tool",
        tool_call_id: finishCall.id,
        name: "finish",
        content: outcome.block,
      });
      appendAdvisory(session, outcome);
      callbacks.onToolResult?.("finish", false, firstLine(outcome.block));
    }

    // The calls left to execute: everything but a `finish` handled above.
    const pending = response.toolCalls.filter((tc) => tc !== finishCall);

    // Fire onToolCall for each call, then execute.
    for (const tc of pending) {
      callbacks.onToolCall?.(tc.name, tc.arguments);
    }

    // Execute the (non-finish) tool calls, with tool:before / tool:after
    // dispatched around each of them (hooks §3.1).
    const hooked = makeToolLifecycle(session);
    const results = await executeToolCalls(
      registry,
      pending,
      config.maxToolOutputChars,
      hooked?.lifecycle,
    );
    for (const result of results) {
      const call = pending.find((tc) => tc.id === result.tool_call_id);
      const blocked = hooked?.wasBlocked(result.tool_call_id) ?? false;
      const ok = !blocked && !result.content.startsWith("Error:");
      const summary = firstLine(result.content);
      callbacks.onToolResult?.(call?.name ?? "tool", ok, summary);
      session.messages.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        name: call?.name,
        content: result.content,
      });
      // hooks §3.5: a tool's advisory message follows its result message.
      appendAdvisory(session, hooked?.advisoryFor(result.tool_call_id));
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
  // on:compaction (hooks §3.1): advisory output lands before the recap call.
  appendAdvisory(session, session.hooks.dispatch("on:compaction", ctxOf(session)));

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

/** The dispatch options every session-level hook event shares. */
function ctxOf(session: Session): { depth: number } {
  return { depth: session.depth };
}

/**
 * Append a hook's advisory message to the conversation as a single system
 * message (hooks spec §3.5). A dispatch with no advisory changes nothing.
 */
function appendAdvisory(
  session: Session,
  outcome: HookOutcome | string | null | undefined,
): void {
  const advisory = typeof outcome === "string" ? outcome : outcome?.advisory;
  if (!advisory) return;
  session.messages.push({ role: "system", content: advisory });
}

/**
 * Bridge one batch of tool calls to the hooks system, or `undefined` when no
 * hook could fire — the zero-overhead path (hooks §5), which hands
 * `executeToolCalls` no lifecycle at all.
 *
 * Advisory messages are kept per tool call so each one can be appended right
 * after its own tool result, and blocked calls are remembered so the CLI can
 * render them as failures rather than successes.
 */
function makeToolLifecycle(session: Session):
  | {
      lifecycle: ToolLifecycle;
      advisoryFor(callId: string): string | null;
      wasBlocked(callId: string): boolean;
    }
  | undefined {
  if (!session.hooks.active) return undefined;

  const advisories = new Map<string, string[]>();
  const blocked = new Set<string>();
  const note = (callId: string, advisory: string | null) => {
    if (!advisory) return;
    const existing = advisories.get(callId);
    if (existing) existing.push(advisory);
    else advisories.set(callId, [advisory]);
  };

  return {
    lifecycle: {
      before(call) {
        const outcome = session.hooks.dispatch("tool:before", {
          depth: session.depth,
          tool: { name: call.name, args: call.arguments },
        });
        note(call.id, outcome.advisory);
        if (outcome.block !== null) blocked.add(call.id);
        return outcome.block;
      },
      after(call, result) {
        const outcome = session.hooks.dispatch("tool:after", {
          depth: session.depth,
          tool: { name: call.name, args: call.arguments, result },
        });
        note(call.id, outcome.advisory);
      },
    },
    advisoryFor: (callId) => advisories.get(callId)?.join("\n") ?? null,
    wasBlocked: (callId) => blocked.has(callId),
  };
}

/** First line of a string, trimmed to a short summary. */
function firstLine(s: string): string {
  const line = s.split("\n", 1)[0].trim();
  return line.length > 80 ? line.slice(0, 77) + "…" : line;
}
