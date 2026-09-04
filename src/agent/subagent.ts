import type { Config, Message, Session } from "../types.js";
import { DEFAULT_SUBAGENT_PROMPT } from "../config/defaults.js";
import { buildToolRegistry } from "../tools/index.js";
import {
  makeSpawnSubagentTool,
  type SubagentRunOptions,
  type SubagentRunner,
} from "../tools/spawnSubagent.js";
import { runTurn, type AgentCallbacks } from "./loop.js";
import { LLMError } from "../llm/errors.js";
import { defaultLLMClient, type LLMClient } from "../llm/client.js";

/**
 * A live-output event from a running subagent (spec §3.8.6). The CLI renders
 * these indented under the parent's `→ spawn_subagent(<task>)` line.
 */
export type SubagentRenderEvent =
  | { kind: "token"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> }
  | { kind: "toolResult"; name: string; ok: boolean; summary: string }
  | { kind: "compacting" }
  | { kind: "end"; ok: boolean; label: string };

/**
 * Renders a subagent's live output. `depth` is the subagent's nesting depth
 * (1 for a direct child of the main agent), used for indentation.
 */
export type SubagentRender = (
  depth: number,
  event: SubagentRenderEvent,
) => void;

/**
 * Build a `SubagentRunner` for a given config and LLM client (spec §3.8).
 *
 * The runner is recursive: each subagent it creates gets its own isolated
 * session (own `messages`, own background-command manager, own registry) whose
 * registry includes a `spawn_subagent` tool at the subagent's depth, so a
 * subagent may in turn spawn its own subagents — bounded by
 * `config.maxSubagentDepth` (enforced by the tool, E20).
 *
 * The runner never throws: every outcome (DONE, CAP_REACHED, FAILED) is
 * returned as a result string so a subagent failure is *data*, not *control*
 * (E18–E20, the error-split invariant).
 *
 * `render` (optional) receives the subagent's live-output events so the CLI
 * can display them indented (spec §3.8.6). When omitted, the subagent runs
 * silently (useful for tests and non-interactive callers).
 */
export function makeSubagentRunner(
  config: Config,
  client: LLMClient = defaultLLMClient,
  render?: SubagentRender,
): SubagentRunner {
  return async (opts: SubagentRunOptions): Promise<string> => {
    // Build the subagent's isolated session: fresh messages, fresh manager,
    // and a registry that includes a spawn tool at this subagent's depth.
    const { registry, manager } = buildToolRegistry(config);
    registry.register(
      makeSpawnSubagentTool(
        makeSubagentRunner(config, client, render),
        opts.depth,
        config.maxSubagentDepth,
        config.subagentMaxIterations,
      ),
    );

    // The subagent's effective iteration cap is `opts.maxIterations` (already
    // capped by the tool to min(requested, subagentMaxIterations)).
    const subagentConfig: Config = {
      ...config,
      maxIterations: opts.maxIterations,
    };
    const systemPrompt = opts.systemPrompt ?? DEFAULT_SUBAGENT_PROMPT;
    const session: Session = {
      messages: [{ role: "system", content: systemPrompt }],
      config: subagentConfig,
      lastPromptTokens: null,
    };

    // Adapt the render callback into the agent loop's AgentCallbacks.
    const emit = (event: SubagentRenderEvent) => render?.(opts.depth, event);
    const callbacks: AgentCallbacks = {
      onToken: (t) => emit({ kind: "token", text: t }),
      onToolCall: (name, args) => emit({ kind: "toolCall", name, args }),
      onToolResult: (name, ok, summary) =>
        emit({ kind: "toolResult", name, ok, summary }),
      onCompacting: () => emit({ kind: "compacting" }),
    };

    try {
      const result = await runTurn(
        session,
        opts.task,
        registry,
        callbacks,
        undefined,
        client,
      );

      // DONE: the subagent called finish — return its answer verbatim.
      if (result.kind === "finished") {
        emit({ kind: "end", ok: true, label: "done" });
        return result.answer;
      }

      // CAP_REACHED: the loop hit the iteration cap without finish (E10).
      if (result.kind === "cap") {
        const lastText = lastAssistantText(session.messages);
        emit({ kind: "end", ok: true, label: "cap reached" });
        return lastText ?? "iteration cap reached";
      }

      // E11: the model emitted plain text with no tool calls — treat it as the
      // subagent's final answer.
      emit({ kind: "end", ok: true, label: "done" });
      return result.answer;
    } catch (err) {
      // FAILED: an LLM/server error (E3–E5) or any other failure is returned as
      // a descriptive string; the parent turn continues.
      const message =
        err instanceof LLMError ? err.message : (err as Error).message;
      emit({ kind: "end", ok: false, label: "failed" });
      return `subagent failed: ${message}`;
    } finally {
      // E21: the subagent's background-command handles are discarded with the
      // subagent, whether it ended via finish, cap, or failure.
      manager.killAll();
    }
  };
}

/** The most recent non-empty assistant text in a message list, or null. */
function lastAssistantText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.content && m.content.trim() !== "") {
      return m.content;
    }
  }
  return null;
}
