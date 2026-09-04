import type { Config, Session } from "../types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../config/defaults.js";
import {
  buildToolRegistry,
  type BackgroundCommandManager,
} from "../tools/index.js";
import { makeSpawnSubagentTool } from "../tools/spawnSubagent.js";
import { makeSubagentRunner, type SubagentRender } from "./subagent.js";
import { defaultLLMClient, type LLMClient } from "../llm/client.js";
import { HookManager } from "../hooks/index.js";

/**
 * Optional dependencies for a session (spec §3.8). Both default to the
 * built-in behavior, so `createSession(config)` is unchanged for existing
 * callers.
 */
export interface SessionOptions {
  /** The LLM client used by the session and any subagents it spawns. */
  client?: LLMClient;
  /** Renders subagent live output (spec §3.8.6); omitted → silent. */
  render?: SubagentRender;
  /**
   * The session's lifecycle hooks (hooks spec §2.2). Omitted → an empty
   * manager, which is inert and costs nothing.
   */
  hooks?: HookManager;
}

/**
 * Create a new in-memory session (spec §2.1). No persistent state.
 *
 * The registry is built from the standard catalog and then extended with the
 * `spawn_subagent` tool (spec §3.8), wired to a runner that executes the nested
 * agent loop. The main agent is at depth 0.
 *
 * Hooks are already loaded by the caller (loading is async and fatal on
 * failure); this function only attaches the manager and fires `session:start`,
 * whose advisory output joins the initial messages (hooks spec §3.5).
 */
export function createSession(
  config: Config,
  options: SessionOptions = {},
): {
  session: Session;
  registry: ReturnType<typeof buildToolRegistry>["registry"];
  manager: BackgroundCommandManager;
} {
  const { registry, manager } = buildToolRegistry(config);
  const client = options.client ?? defaultLLMClient;
  const hooks = options.hooks ?? new HookManager();
  registry.register(
    makeSpawnSubagentTool(
      makeSubagentRunner(config, client, options.render, hooks),
      0,
      config.maxSubagentDepth,
      config.subagentMaxIterations,
    ),
  );
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const session: Session = {
    messages: [{ role: "system", content: systemPrompt }],
    config,
    lastPromptTokens: null,
    hooks,
    depth: 0,
  };

  const started = hooks.dispatch("session:start", { depth: 0 });
  if (started.advisory) {
    session.messages.push({ role: "system", content: started.advisory });
  }

  return { session, registry, manager };
}
