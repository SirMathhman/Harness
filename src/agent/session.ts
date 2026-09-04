import type { Session } from "../types.js";
import type { ToolRegistry, BackgroundCommandManager } from "../tools/index.js";
import type { LLMClient } from "../llm/client.js";
import {
  defaultGraph,
  defaultProfileName,
  ProfileHasNoModelError,
  profileNames,
  resolveProfile,
  UnknownProfileError,
  type ResourceGraph,
} from "../profiles/index.js";
import {
  materializeProfile,
  type AgentContext,
  type SubagentRender,
} from "./subagent.js";

/** Optional dependencies for a session. All have working defaults. */
export interface SessionOptions {
  /**
   * The resource graph built from `.vise/index.ts` (profiles spec §3.10).
   * Omitted → the built-in defaults: one implicit profile, every built-in
   * tool, no hooks, the default model.
   */
  graph?: ResourceGraph;
  /** The profile to start under. Omitted → the graph's default (§3.10 step 5). */
  profile?: string;
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
  /** The active profile's name; `""` for the implicit default. */
  readonly profile: string;
  /** Every user-defined profile name, in the order the config created them. */
  profiles(): string[];
  /**
   * Switch to `name`, re-resolving prompt, tools, hooks, and model
   * (profiles spec §3.6).
   *
   * @throws UnknownProfileError when no such profile exists.
   * @throws ProfileHasNoModelError when the profile resolves to no model.
   *   Either way the session is left untouched.
   */
  switchProfile(name: string): void;
  /** Whether hooks are enabled session-wide (`/hooks on|off`). */
  hooksEnabled(): boolean;
  /** Enable or disable every hook, now and for profiles switched to later. */
  setHooksEnabled(enabled: boolean): void;
}

/**
 * Create a new in-memory session (spec §2.1). No persistent state.
 *
 * The session starts under the graph's default profile: the one named
 * `default`, else the first profile the config created, else the implicit
 * empty profile (profiles spec §3.10 step 5). Its system prompt, tool set,
 * hooks, and model all come from resolving that profile.
 *
 * `session:start` fires once here, against the starting profile's hooks; its
 * advisory output joins the initial messages (hooks spec §3.5).
 */
export function createSession(options: SessionOptions = {}): SessionHandle {
  const graph = options.graph ?? defaultGraph();
  const startingProfile = options.profile ?? defaultProfileName(graph);

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

  const initial = materializeProfile(
    resolveProfile(graph, startingProfile),
    ctx,
    0,
  );

  const session: Session = {
    messages: [{ role: "system", content: initial.systemPrompt }],
    config: initial.config,
    lastPromptTokens: null,
    hooks: initial.hooks,
    depth: 0,
    profile: startingProfile,
  };

  const handle = {
    session,
    registry: initial.registry,
    manager: initial.manager,
    profile: startingProfile,
    profiles: () => profileNames(graph),
    hooksEnabled: () => hooksEnabled,
    setHooksEnabled(enabled: boolean) {
      hooksEnabled = enabled;
      session.hooks.setEnabled(enabled);
    },
    switchProfile(name: string) {
      // Resolve *before* touching anything, so an unknown or unusable profile
      // leaves the session exactly as it was (spec §4).
      const next = materializeProfile(resolveProfile(graph, name), ctx, 0);
      if (next.config.model === null) throw new ProfileHasNoModelError(name);

      // The outgoing profile's background commands belong to the profile, not
      // the conversation, so they die with it (E21).
      handle.manager.killAll();

      applySystemPrompt(session, next.systemPrompt, graph.switchMode);
      session.config = next.config;
      session.hooks = next.hooks;
      session.profile = name;
      handle.registry = next.registry;
      handle.manager = next.manager;
      handle.profile = name;
    },
  };

  const started = session.hooks.dispatch("session:start", { depth: 0 });
  if (started.advisory) {
    session.messages.push({ role: "system", content: started.advisory });
  }

  return handle;
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

export { ProfileHasNoModelError, UnknownProfileError };
