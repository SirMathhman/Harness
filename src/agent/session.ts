import type { Config, Session } from "../types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../config/defaults.js";
import {
  buildToolRegistry,
  type BackgroundCommandManager,
} from "../tools/index.js";

/**
 * Create a new in-memory session (spec §2.1). No persistent state.
 */
export function createSession(config: Config): {
  session: Session;
  registry: ReturnType<typeof buildToolRegistry>["registry"];
  manager: BackgroundCommandManager;
} {
  const { registry, manager } = buildToolRegistry(config);
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const session: Session = {
    messages: [{ role: "system", content: systemPrompt }],
    config,
    lastPromptTokens: null,
  };
  return { session, registry, manager };
}
