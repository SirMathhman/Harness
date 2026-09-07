import type { Message, Session, Skill } from "../types.js";
import type { ToolRegistry, BackgroundCommandManager } from "../tools/index.js";
import type { LLMClient } from "../llm/client.js";
import {
  AmbiguousModelError,
  allModelEntries,
  defaultGraph,
  defaultProfileName,
  findModelsByRef,
  MissingMaxContextError,
  ModelNotAvailableError,
  ProfileHasNoModelError,
  profileEntries,
  profileNames,
  resolveProfile,
  systemPromptOf,
  UnknownModelError,
  UnknownProfileError,
  type ModelListEntry,
  type ProfileEntry,
  type ResourceGraph,
  type ResourceId,
} from "../profiles/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import {
  materializeProfile,
  type AgentContext,
  type SubagentRender,
} from "./subagent.js";

/** Optional dependencies for a session. All have working defaults. */
export interface SessionOptions {
  /**
   * The resource graph built from `.vise/index.ts` (profiles spec §3.10),
   * including every model discovered from its providers at startup
   * (providers spec §3.6). Omitted → the built-in defaults: one implicit
   * profile, every built-in tool, no hooks, no providers.
   */
  graph?: ResourceGraph;
  /**
   * The profile to start under. Omitted → the implicit built-in profile
   * (config spec §3.7). Callers that want to restore a saved profile (or any
   * other specific one) must resolve it and pass it explicitly.
   */
  profile?: string;
  /**
   * The model name saved in the state file at the previous exit (providers
   * spec §3.4, §3.9). Pins the active model whenever a profile is (re)selected
   * — at session start and on every `/profile` switch — as long as that model
   * is still in the profile's available set. Ignored by subagent spawn.
   */
  lastModel?: string | null;
  /** The LLM client used by the session and any subagents it spawns. */
  client?: LLMClient;
  /** Renders subagent live output (spec §3.8.6); omitted → silent. */
  render?: SubagentRender;
  /** The `cwd` handed to every `HookContext`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Where hook errors and warnings go. Defaults to stderr. */
  log?: (message: string) => void;
}

/**
 * A running session plus the handles the REPL needs to drive it.
 *
 * `registry` and `manager` are re-created on every profile switch, so callers
 * must read them off the handle each turn rather than caching them.
 */
export interface SessionHandle {
  /** The live session. Its `messages` survive a profile switch. */
  readonly session: Session;
  /** The active profile's tool registry. Replaced on every switch. */
  readonly registry: ToolRegistry;
  /** The active profile's background-command manager. Replaced on switch. */
  readonly manager: BackgroundCommandManager;
  /** The active profile's name; `"Agent"` for the implicit default. */
  readonly profile: string;
  /** Every user-defined profile name, in the order the config created them. */
  profiles(): string[];
  /**
   * Every skill in the session, in creation order (skills spec §3.6). Skills
   * are global, so this does not change on a profile switch.
   */
  skills(): Skill[];
  /**
   * Every profile, including the implicit built-in one, tagged with its
   * origin (config spec §3.9): builtin, then global, then project.
   */
  profileEntries(): ProfileEntry[];
  /**
   * Switch to `name`, re-resolving prompt, tools, hooks, and model
   * (profiles spec §3.6; providers spec §3.4).
   *
   * @throws UnknownProfileError when no such profile exists.
   * @throws ProfileHasNoModelError when the profile resolves to no model.
   * @throws MissingMaxContextError when the resolved model reports no
   *   context-window size.
   *   Either way the session is left untouched.
   */
  switchProfile(name: string): void;
  /**
   * Every model in the graph — config-declared or provider-discovered — for
   * `/model` listing (providers spec §3.8).
   */
  modelEntries(): ModelListEntry[];
  /** The `ResourceId` of the currently active model, or `null`. */
  activeModelId(): ResourceId | null;
  /**
   * Switch the active model to the one named by `ref` — a bare model name, or
   * `<provider>/<name>` to disambiguate (providers spec §3.8) — adopting its
   * whole resource (`baseUrl`, `apiKey`, `temperature`, `maxContext`) into the
   * session's config. The conversation and system prompt are kept.
   *
   * @throws UnknownModelError when no model matches `ref`.
   * @throws AmbiguousModelError when `ref` matches more than one provider.
   * @throws ModelNotAvailableError when the match is outside the active
   *   profile's `models` whitelist.
   * @throws MissingMaxContextError when the matched model reports no
   *   context-window size.
   *   In every case the session is left untouched.
   */
  switchModel(ref: string): void;
  /** Whether hooks are enabled session-wide (`/hooks on|off`). */
  hooksEnabled(): boolean;
  /** Enable or disable every hook, now and for profiles switched to later. */
  setHooksEnabled(enabled: boolean): void;
  /**
   * Clear the conversation (`/clear`): drop every user/assistant/tool exchange
   * while keeping the leading system message(s) — the agent's instructions —
   * and reset the compaction token counter. Background commands and the active
   * profile/model are untouched.
   */
  clearConversation(): void;
  /**
   * Replace the conversation with a loaded one (spec §3.3 R2, R3): re-resolve
   * the system prompt for `profile`, prepend it, then install `messages`.
   * Resets `lastPromptTokens` and sets the active profile/model. Assumes
   * `profile` names a profile in the graph; the caller handles the R6
   * fallback for a missing profile.
   *
   * @throws UnknownProfileError when no such profile exists.
   * @throws ProfileHasNoModelError when the profile resolves to no model.
   * @throws MissingMaxContextError when the resolved model reports no
   *   context-window size.
   */
  loadConversation(messages: Message[], profile: string, model: string | null): void;
}

/**
 * Create a new in-memory session (spec §2.1). No persistent state of its own —
 * the caller (the REPL entry point) is responsible for resolving a saved
 * profile from the state file and passing it as `options.profile` (config
 * spec §3.7); with no `profile` given, the session starts under the implicit
 * built-in profile. Its system prompt, tool set, hooks, and model all come
 * from resolving that profile.
 *
 * `session:start` fires once here, against the starting profile's hooks; its
 * advisory output joins the initial messages (hooks spec §3.5).
 */
export function createSession(options: SessionOptions = {}): SessionHandle {
  const graph = options.graph ?? defaultGraph();
  const startingProfile = options.profile ?? defaultProfileName(graph);
  const lastModel = options.lastModel ?? null;

  // One mutable flag, read by every hook manager the session ever builds, so
  // `/hooks off` keeps holding after a profile switch and inside subagents.
  let hooksEnabled = true;

  const ctx: AgentContext = {
    graph,
    hooksEnabled: () => hooksEnabled,
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.render !== undefined ? { render: options.render } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  };

  const startingResolved = resolveProfile(graph, startingProfile, {
    modelNameHint: lastModel,
  });
  const initial = materializeProfile(startingResolved, ctx, 0);

  const session: Session = {
    messages: [{ role: "system", content: initial.systemPrompt }],
    config: initial.config,
    lastPromptTokens: null,
    hooks: initial.hooks,
    depth: 0,
    profile: startingProfile,
  };

  // Tracks the profile currently active's model state, for `/model` listing
  // and for enforcing its `models` whitelist on `switchModel` (providers spec
  // §3.4, §3.8). Updated on every `switchProfile`.
  let activeModelId: ResourceId | null = startingResolved.modelId;
  let currentAvailable: ResourceId[] = startingResolved.availableModelIds;

  const handle = {
    session,
    registry: initial.registry,
    manager: initial.manager,
    profile: startingProfile,
    profiles: () => profileNames(graph),
    profileEntries: () => profileEntries(graph),
    skills: () => [...graph.skills.values()],
    hooksEnabled: () => hooksEnabled,
    setHooksEnabled(enabled: boolean) {
      hooksEnabled = enabled;
      session.hooks.setEnabled(enabled);
    },
    clearConversation() {
      // Keep the leading system message(s) — the agent's instructions — and
      // drop every exchange after them. In `append` switch mode there can be
      // more than one leading system message; all of them are kept.
      let i = 0;
      while (
        i < session.messages.length &&
        session.messages[i].role === "system"
      ) {
        i++;
      }
      session.messages = session.messages.slice(0, i);
      session.lastPromptTokens = null;
    },
    loadConversation(messages: Message[], profile: string, model: string | null) {
      // Resolve *before* touching anything, so a failed load leaves the
      // session exactly as it was (spec §4).
      const resolved = resolveProfile(graph, profile, {
        modelNameHint: model,
      });
      const next = materializeProfile(resolved, ctx, 0);
      if (next.config.model === null) throw new ProfileHasNoModelError(profile);

      // The outgoing profile's background commands belong to the profile, not
      // the conversation, so they die with it (E21).
      handle.manager.killAll();

      // R2: re-derive the system prompt from the profile; R3: replace the
      // conversation with the freshly-resolved prompt + the saved messages.
      session.messages = [
        { role: "system", content: systemPromptOf(resolved) },
        ...messages,
      ];
      session.config = next.config;
      session.hooks = next.hooks;
      session.profile = profile;
      session.lastPromptTokens = null;
      handle.registry = next.registry;
      handle.manager = next.manager;
      handle.profile = profile;
      activeModelId = resolved.modelId;
      currentAvailable = resolved.availableModelIds;
    },
    switchProfile(name: string) {
      // Resolve *before* touching anything, so an unknown or unusable profile
      // leaves the session exactly as it was (spec §4).
      const resolved = resolveProfile(graph, name, {
        modelNameHint: lastModel,
      });
      const next = materializeProfile(resolved, ctx, 0);
      if (next.config.model === null) throw new ProfileHasNoModelError(name);

      // The outgoing profile's background commands belong to the profile, not
      // the conversation, so they die with it (E21).
      handle.manager.killAll();

      applySystemPrompt(
        session,
        next.systemPrompt,
        graph.runtime.profileSwitchMode,
      );
      session.config = next.config;
      session.hooks = next.hooks;
      session.profile = name;
      handle.registry = next.registry;
      handle.manager = next.manager;
      handle.profile = name;
      activeModelId = resolved.modelId;
      currentAvailable = resolved.availableModelIds;
    },
    modelEntries: () => allModelEntries(graph),
    activeModelId: () => activeModelId,
    switchModel(ref: string) {
      // Look up *before* touching anything, so a failed switch leaves the
      // session exactly as it was.
      const matches = findModelsByRef(graph, ref);
      if (matches.length === 0) {
        throw new UnknownModelError(ref);
      }
      if (matches.length > 1) {
        throw new AmbiguousModelError(
          ref,
          matches.map((m) => m.providerName ?? "(none)"),
        );
      }
      const match = matches[0];
      if (!currentAvailable.includes(match.id)) {
        throw new ModelNotAvailableError(
          ref,
          session.profile,
          currentAvailable
            .map((id) => modelNameOf(graph, id))
            .filter((n): n is string => n !== undefined),
        );
      }
      const resource = graph.resources.get(match.id);
      const def = resource?.kind === "model" ? resource.def : undefined;
      if (def === undefined) throw new UnknownModelError(ref);
      if (def.maxContext === undefined) {
        throw new MissingMaxContextError(def.name, def.baseUrl);
      }

      session.config = {
        ...session.config,
        model: def.name,
        baseUrl: def.baseUrl,
        apiKey: def.apiKey,
        temperature: def.temperature ?? DEFAULT_CONFIG.temperature,
        maxContext: def.maxContext,
      };
      activeModelId = match.id;
    },
  };

  const started = session.hooks.dispatch("session:start", { depth: 0 });
  if (started.advisory) {
    session.messages.push({ role: "system", content: started.advisory });
  }

  return handle;
}

/** The name of the Model resource behind `id`, or `undefined`. */
function modelNameOf(graph: ResourceGraph, id: ResourceId): string | undefined {
  const resource = graph.resources.get(id);
  return resource?.kind === "model" ? resource.def.name : undefined;
}

/**
 * Install a new profile's system prompt while keeping the conversation
 * (profiles spec §3.6).
 *
 * `replace` (the default) rewrites the leading system message in place;
 * `append` leaves it and adds the new prompt as another system message, so the
 * model sees both.
 */
function applySystemPrompt(
  session: Session,
  systemPrompt: string,
  mode: "replace" | "append",
): void {
  if (mode === "append") {
    session.messages.push({ role: "system", content: systemPrompt });
    return;
  }
  const first = session.messages[0];
  if (first?.role === "system") {
    first.content = systemPrompt;
  } else {
    session.messages.unshift({ role: "system", content: systemPrompt });
  }
}

export {
  AmbiguousModelError,
  ModelNotAvailableError,
  ProfileHasNoModelError,
  UnknownModelError,
  UnknownProfileError,
};
