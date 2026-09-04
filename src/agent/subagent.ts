import type { Config, Message, Session } from "../types.js";
import { DEFAULT_SUBAGENT_PROMPT } from "../config/defaults.js";
import {
  buildToolRegistry,
  ToolRegistry,
  type BackgroundCommandManager,
} from "../tools/index.js";
import {
  makeSpawnSubagentTool,
  type SubagentRunOptions,
  type SubagentRunner,
} from "../tools/spawnSubagent.js";
import { runTurn, type AgentCallbacks } from "./loop.js";
import { LLMError } from "../llm/errors.js";
import { defaultLLMClient, type LLMClient } from "../llm/client.js";
import { HookManager } from "../hooks/index.js";
import {
  profileNames,
  resolveProfile,
  systemPromptOf,
  UnknownProfileError,
  type ResolvedProfile,
  type ResourceGraph,
} from "../profiles/index.js";

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
 * The session-wide context every agent in the tree shares: the resource graph
 * it resolves profiles from, the LLM client, and how output and hook problems
 * are surfaced.
 */
export interface AgentContext {
  /** The resource graph built from `.vise/index.ts` (profiles spec §3.10). */
  graph: ResourceGraph;
  /** The LLM client used by every agent in the tree. */
  client?: LLMClient;
  /** Renders subagent live output (spec §3.8.6); omitted → silent. */
  render?: SubagentRender;
  /**
   * Whether hooks are enabled session-wide. `/hooks off` flips one flag that
   * every agent in the tree — including subagents built later — reads.
   */
  hooksEnabled?: () => boolean;
  /** The `cwd` handed to every `HookContext`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Where hook errors and warnings go. Defaults to stderr. */
  log?: (message: string) => void;
}

/** One profile turned into the concrete pieces an agent loop needs. */
export interface MaterializedProfile {
  /** The resolved runtime + model settings. */
  config: Config;
  /** The tools this profile exposes, including `spawn_subagent` when allowed. */
  registry: ToolRegistry;
  /** The background-command manager backing `run_command`. */
  manager: BackgroundCommandManager;
  /** A hook manager holding only this profile's hooks. */
  hooks: HookManager;
  /** The system prompt the agent runs under. */
  systemPrompt: string;
}

/**
 * Turn a resolved profile into a runnable agent configuration
 * (profiles spec §3.5).
 *
 * This is the single place where a profile becomes a tool registry, a hook
 * manager, and a `Config` — used both for the main session and for every
 * subagent, so a subagent under profile "worker" gets exactly the same
 * treatment the main agent would.
 *
 * `depth` is the nesting depth of the agent being built; it fixes the depth
 * bound of the `spawn_subagent` tool this profile hands out.
 */
export function materializeProfile(
  resolved: ResolvedProfile,
  ctx: AgentContext,
  depth: number,
  overrides: { maxIterations?: number | null; systemPrompt?: string } = {},
): MaterializedProfile {
  const config: Config = {
    ...resolved.config,
    ...(overrides.maxIterations !== undefined
      ? { maxIterations: overrides.maxIterations }
      : {}),
  };

  const { registry, manager } = buildToolRegistry(config, {
    builtins: resolved.builtinTools,
    custom: resolved.customTools,
  });

  // spawn_subagent is built here rather than in the tool layer: it needs a
  // runner, the active profile's policy, and this agent's depth.
  if (
    resolved.builtinTools === null ||
    resolved.builtinTools.includes("spawn_subagent")
  ) {
    registry.register(
      makeSpawnSubagentTool({
        runner: makeSubagentRunner(ctx),
        depth,
        parentProfile: resolved.name,
        policy: resolved.subagent,
        fallbackMaxDepth: config.maxSubagentDepth,
        subagentMaxIterations: config.subagentMaxIterations,
        knownProfiles: profileNames(ctx.graph),
      }),
    );
  }

  const hooks = new HookManager(resolved.hooks, {
    ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
    ...(ctx.log !== undefined ? { log: ctx.log } : {}),
  });
  hooks.setEnabled(ctx.hooksEnabled?.() ?? true);

  return {
    config,
    registry,
    manager,
    hooks,
    systemPrompt: overrides.systemPrompt ?? systemPromptOf(resolved),
  };
}

/**
 * Build a `SubagentRunner` over an agent context (spec §3.8, profiles §3.12).
 *
 * The runner is recursive: each subagent gets its own isolated session (own
 * `messages`, own background-command manager, own registry, own hooks) built
 * from *its* profile, so a subagent spawned under "researcher" runs with the
 * researcher prompt, tools, hooks, and model — not the parent's. Its registry
 * includes a `spawn_subagent` tool bound to its own depth and its own
 * profile's policy, so nesting is bounded by whichever profile is doing the
 * spawning.
 *
 * The runner never throws: every outcome (DONE, CAP_REACHED, FAILED) is
 * returned as a result string so a subagent failure is *data*, not *control*
 * (E18–E20, the error-split invariant).
 */
export function makeSubagentRunner(ctx: AgentContext): SubagentRunner {
  const client = ctx.client ?? defaultLLMClient;

  return async (opts: SubagentRunOptions): Promise<string> => {
    const emit = (event: SubagentRenderEvent) => ctx.render?.(opts.depth, event);

    let resolved: ResolvedProfile;
    try {
      resolved = resolveProfile(ctx.graph, opts.profile);
    } catch (err) {
      // The tool validates the name first, so this is only reachable if the
      // graph changed underneath us. Still data, never control.
      if (err instanceof UnknownProfileError) {
        emit({ kind: "end", ok: false, label: "failed" });
        return `subagent failed: ${err.message}`;
      }
      throw err;
    }

    // A subagent's prompt: the explicit one from the call, else its profile's
    // own, else the generic worker prompt (spec §3.8.2).
    const systemPrompt =
      opts.systemPrompt ??
      resolved.config.systemPrompt ??
      DEFAULT_SUBAGENT_PROMPT;

    const { config, registry, manager, hooks } = materializeProfile(
      resolved,
      ctx,
      opts.depth,
      { maxIterations: opts.maxIterations, systemPrompt },
    );

    const session: Session = {
      messages: [{ role: "system", content: systemPrompt }],
      config,
      lastPromptTokens: null,
      hooks,
      depth: opts.depth,
      profile: resolved.name,
    };

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
