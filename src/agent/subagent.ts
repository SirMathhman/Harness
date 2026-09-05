import type { Config, Message, Session } from "../types.js";
import { DEFAULT_SUBAGENT_PROMPT } from "../config/defaults.js";
import {
  appendSkillIndex,
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
import { HookManager, type RegisteredHook } from "../hooks/index.js";
import type { Provider } from "../providers/index.js";
import {
  availableModelIds,
  MissingMaxContextError,
  profileNames,
  resolveProfile,
  systemPromptOf,
  UnknownProfileError,
  type ModelSelection,
  type ResolvedProfile,
  type ResourceGraph,
  type ResourceId,
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

/**
 * The agent a subagent is being spawned *from* (KV spec §3.6, §8.3).
 *
 * The runner fires `subagent:before` / `subagent:after` against this manager,
 * at this depth — the depth whose KV cache is saved and restored around the
 * nested run. Omitted (as in a bare unit test) → neither event fires.
 */
export interface SpawnerContext {
  /** The spawning agent's hook manager. */
  hooks: HookManager;
  /** The spawning agent's depth: 0 for the main agent. */
  depth: number;
  /**
   * The spawning agent's active model name (KV spec §3.6). The runner passes
   * it to the `subagent:before` / `subagent:after` dispatches so a provider's
   * KV save/restore can tell a llama.cpp router which model's slot to act on.
   */
  model?: string;
}

/** The header the identity paragraph carries in the system prompt. */
export const IDENTITY_HEADER = "## Identity";

/**
 * The identity paragraph appended to a system prompt: what the agent is
 * (Vise), which model it's running, and which provider serves it. Lets the
 * model answer "what are you running on" from its own prompt instead of
 * guessing or claiming to be the model it happens to be talking to — the
 * same reasoning that puts the skill index in the prompt so it can answer
 * "what can you do".
 *
 * `""` when the profile resolved to no model (`config.model === null`) —
 * there is nothing accurate to report, and the session cannot run a turn in
 * that state anyway.
 */
export function identitySection(
  config: Config,
  providerName: string | undefined,
): string {
  if (config.model === null) return "";
  const via = providerName !== undefined ? ` via the "${providerName}" provider` : "";
  return (
    `${IDENTITY_HEADER}\n` +
    `You are Vise, a local coding-agent harness. You are running model ` +
    `"${config.model}"${via} at ${config.baseUrl}, with a ` +
    `${config.maxContext}-token context window.`
  );
}

/** Append the identity paragraph to a resolved system prompt. */
export function appendIdentity(
  systemPrompt: string,
  config: Config,
  providerName: string | undefined,
): string {
  const section = identitySection(config, providerName);
  return section === "" ? systemPrompt : `${systemPrompt}\n\n${section}`;
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
    // Skills are global (skills spec §3.7): every agent, at every depth, gets
    // the same store behind `list_skills` / `read_skill`.
    skills: ctx.graph.skills,
  });

  // The provider behind this agent's active model may contribute hooks of its
  // own — the KV persistence hook (KV spec §3.2, §8.2). They are merged into
  // every session at every depth, on top of the profile's own hooks.
  const provider = activeProvider(ctx.graph, resolved.modelId);
  const hooks = new HookManager(
    [...resolved.hooks, ...providerHooks(provider)],
    {
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      ...(ctx.log !== undefined ? { log: ctx.log } : {}),
    },
  );
  hooks.setEnabled(ctx.hooksEnabled?.() ?? true);

  // spawn_subagent is built here rather than in the tool layer: it needs a
  // runner, the active profile's policy, this agent's depth — and this agent's
  // hook manager, which the runner fires `subagent:before`/`after` on.
  if (
    resolved.builtinTools === null ||
    resolved.builtinTools.includes("spawn_subagent")
  ) {
    registry.register(
      makeSpawnSubagentTool({
        runner: makeSubagentRunner(ctx, {
          hooks,
          depth,
          ...(config.model !== null ? { model: config.model } : {}),
        }),
        depth,
        parentProfile: resolved.name,
        policy: resolved.subagent,
        fallbackMaxDepth: config.maxSubagentDepth,
        subagentMaxIterations: config.subagentMaxIterations,
        knownProfiles: profileNames(ctx.graph),
        serializeRuns: provider?.serializeSubagents === true,
        parentModel: {
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          temperature: config.temperature,
          maxContext: config.maxContext,
          modelId: resolved.modelId,
        },
      }),
    );
  }

  return {
    config,
    registry,
    manager,
    hooks,
    // Identity, then the skill index, appended after the profile's own prompt
    // (or the subagent prompt an override supplies), so every agent in the
    // tree knows what it's running on (self-knowledge) and what it can load
    // (skills spec §3.3, §3.7).
    systemPrompt: appendSkillIndex(
      appendIdentity(
        overrides.systemPrompt ?? systemPromptOf(resolved),
        config,
        provider?.name,
      ),
      ctx.graph.skills,
    ),
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
 *
 * `spawner` is the agent doing the spawning: the nested run is wrapped in its
 * `subagent:before` / `subagent:after` events, at its depth, so a provider can
 * save and restore whatever the nested run would evict — the llama.cpp KV
 * cache (KV spec §3.6). Omitted → neither event fires.
 */
export function makeSubagentRunner(
  ctx: AgentContext,
  spawner?: SpawnerContext,
): SubagentRunner {
  const client = ctx.client ?? defaultLLMClient;

  return async (opts: SubagentRunOptions): Promise<string> => {
    const emit = (event: SubagentRenderEvent) =>
      ctx.render?.(opts.depth, event);

    // Model selection for a subagent (providers spec §3.7): a non-empty
    // `models` whitelist on its profile picks the first match; otherwise (or
    // when the whitelist matches nothing, E-P8) it inherits the parent's
    // active model verbatim. Unlike normal resolution, a `Profile → Model`
    // connection and the state file's `lastModel` are never consulted here.
    const selection = profileModelSelection(ctx.graph, opts.profile);
    let modelId: ResourceId | null = null;
    let inheritParent = false;
    if (selection && selection.length > 0) {
      const available = availableModelIds(ctx.graph, selection);
      if (available.length > 0) {
        modelId = available[0];
      } else {
        ctx.log?.(
          `Warning: subagent profile "${opts.profile}" has a models ` +
            `whitelist that matches no models. Falling back to the parent's ` +
            `active model.`,
        );
        inheritParent = true;
      }
    } else {
      inheritParent = true;
    }

    let resolved: ResolvedProfile;
    try {
      resolved = resolveProfile(ctx.graph, opts.profile, {
        modelId: inheritParent ? null : modelId,
      });
    } catch (err) {
      // The tool validates the name first, so an unknown profile is only
      // reachable if the graph changed underneath us; a missing context size
      // is a real, reachable condition when the whitelist picks a model that
      // reports none. Either way it's data, never control (E18-E20).
      if (
        err instanceof UnknownProfileError ||
        err instanceof MissingMaxContextError
      ) {
        emit({ kind: "end", ok: false, label: "failed" });
        return `subagent failed: ${err.message}`;
      }
      throw err;
    }

    if (inheritParent) {
      resolved = {
        ...resolved,
        // Inheriting the parent's model means inheriting the provider behind
        // it, so the subagent contributes the same provider hooks its parent
        // did and the optimization applies at every depth (KV spec §1.2).
        modelId: opts.parentModel.modelId ?? null,
        config: {
          ...resolved.config,
          baseUrl: opts.parentModel.baseUrl,
          model: opts.parentModel.model,
          apiKey: opts.parentModel.apiKey,
          temperature: opts.parentModel.temperature,
          maxContext: opts.parentModel.maxContext,
        },
      };
    }

    // A subagent's prompt: the explicit one from the call, else its profile's
    // own, else the generic worker prompt (spec §3.8.2).
    const systemPrompt =
      opts.systemPrompt ??
      resolved.config.systemPrompt ??
      DEFAULT_SUBAGENT_PROMPT;

    const materialized = materializeProfile(resolved, ctx, opts.depth, {
      maxIterations: opts.maxIterations,
      systemPrompt,
    });
    const { config, registry, manager, hooks } = materialized;

    const session: Session = {
      // `materialized.systemPrompt`, not the bare `systemPrompt` above: it
      // carries the skill index (skills spec §3.7).
      messages: [{ role: "system", content: materialized.systemPrompt }],
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
      // KV spec §3.6: the spawning agent's KV cache is saved before the nested
      // run starts, on its own hook manager at its own depth.
      if (spawner !== undefined) {
        await spawner.hooks.dispatchAsync("subagent:before", {
          depth: spawner.depth,
          ...(spawner.model !== undefined ? { model: spawner.model } : {}),
        });
      }

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
      // KV spec §3.6: restore in `finally`, so the spawner's cache comes back
      // on every outcome — DONE, CAP_REACHED, FAILED, or a thrown error.
      if (spawner !== undefined) {
        await spawner.hooks.dispatchAsync("subagent:after", {
          depth: spawner.depth,
          ...(spawner.model !== undefined ? { model: spawner.model } : {}),
        });
      }
      // E21: the subagent's background-command handles are discarded with the
      // subagent, whether it ended via finish, cap, or failure.
      manager.killAll();
    }
  };
}

/**
 * The provider behind an agent's active model, or `undefined` when the model
 * was declared directly with `reg.createModel()` (no provider) or the profile
 * resolved to no model at all.
 */
function activeProvider(
  graph: ResourceGraph,
  modelId: ResourceId | null,
): Provider | undefined {
  if (modelId === null) return undefined;
  const resource = graph.resources.get(modelId);
  const providerId =
    resource?.kind === "model" ? resource.def.provider : undefined;
  return providerId !== undefined ? graph.providers.get(providerId) : undefined;
}

/** A provider's contributed hooks, tagged with where they came from (§3.2). */
function providerHooks(provider: Provider | undefined): RegisteredHook[] {
  if (provider?.hooks === undefined) return [];
  return provider.hooks().map((hook) => ({
    hook,
    source: `provider:${provider.name}`,
  }));
}

/** A profile's `models` whitelist, by name, or `undefined` if it has none. */
function profileModelSelection(
  graph: ResourceGraph,
  name: string,
): ModelSelection | undefined {
  const id = graph.profiles.get(name);
  const resource = id !== undefined ? graph.resources.get(id) : undefined;
  return resource?.kind === "profile" ? resource.def.models : undefined;
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
