import type { Config, Session } from "../types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../config/defaults.js";
import {
  buildToolRegistry,
  type BackgroundCommandManager,
} from "../tools/index.js";
import { makeSpawnSubagentTool } from "../tools/spawnSubagent.js";
import { makeSubagentRunner, type SubagentRender } from "./subagent.js";
import { defaultLLMClient, type LLMClient } from "../llm/client.js";

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
}

/**
 * Create a new in-memory session (spec §2.1). No persistent state.
 *
 * The registry is built from the standard catalog and then extended with the
 * `spawn_subagent` tool (spec §3.8), wired to a runner that executes the nested
 * agent loop. The main agent is at depth 0.
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
  registry.register(
    makeSpawnSubagentTool(
      makeSubagentRunner(config, client, options.render),
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
  };
  return { session, registry, manager };
}
