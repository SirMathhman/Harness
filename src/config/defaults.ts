import type { Config } from "../types.js";
import type { RuntimeSettings } from "../profiles/types.js";

/**
 * Built-in default system prompt (profiles spec §3.5).
 * Used by any profile whose `systemPrompt` is the empty string.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a capable, pragmatic coding agent running locally.
You accomplish software-engineering tasks by using the provided tools.

Guidelines:
- Read files before editing them.
- Make precise, minimal edits.
- Run builds/tests to verify your changes when appropriate.
- If a tool call fails, read the error and try a corrected approach.
- When the task is complete, ALWAYS call the \`finish\` tool with a clear, concise summary of what you did.

Use the tools to do the work; do not just describe it.`;

/**
 * Default system prompt for a subagent (spec §3.8.2). Used when the subagent's
 * profile supplies no prompt of its own and the caller passed none.
 */
export const DEFAULT_SUBAGENT_PROMPT = `You are a focused subagent working on a single, well-scoped task.
You were spawned by a parent agent to complete the task below.

Guidelines:
- Complete the given task using the provided tools.
- Read files before editing them.
- Run builds/tests to verify your changes when relevant.
- If a tool call fails, read the error and try a corrected approach.
- Stay focused on the task; do not broaden its scope.
- When the task is complete, ALWAYS call the \`finish\` tool with a concise result.

Your final \`finish\` answer is the only thing returned to the parent agent, so make it a clear, self-contained summary of what you did and found.`;

/**
 * The non-graph runtime settings a config module may override through
 * `reg.setRuntime()` (profiles spec §3.2).
 */
export const DEFAULT_RUNTIME: RuntimeSettings = {
  compactThreshold: 0.8,
  compactKeepMessages: 6,
  commandTimeoutMs: 60000,
  maxToolOutputChars: 20000,
  parallelToolCalls: true,
  shell: "auto",
  maxIterations: null,
  dynamicTools: false,
  subagentMaxIterations: 50,
  maxSubagentDepth: 3,
  profileSwitchMode: "replace",
};

/**
 * A fully defaulted `Config`, minus `maxContext`: the runtime settings plus
 * the default model's parameters. `model` is intentionally null — when unset,
 * Vise auto-discovers the first model from the running server's `/v1/models`
 * (spec §3.10).
 *
 * There is no default context-window size (providers spec §3.11): a resolved
 * model that reports none — no connection prop, no `maxContext` on its
 * definition, no usable value from provider discovery — is a fatal
 * `MissingMaxContextError` rather than a silent guess, since compaction has
 * no threshold to compare against without it.
 */
export const DEFAULT_CONFIG: Omit<Config, "maxContext"> = {
  ...DEFAULT_RUNTIME,
  baseUrl: "http://localhost:8080",
  model: null,
  apiKey: "",
  temperature: 0.2,
  systemPrompt: null,
};

/** The keys of `RuntimeSettings`, used to validate `setRuntime` input. */
export const RUNTIME_KEYS = Object.keys(
  DEFAULT_RUNTIME,
) as (keyof RuntimeSettings)[];
