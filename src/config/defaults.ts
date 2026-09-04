import type { Config } from "../types.js";

/**
 * Built-in default system prompt (spec §6.1).
 * A concise coding-agent persona.
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
 * Built-in defaults (spec §6.1). `model` is intentionally null: when unset, the
 * harness auto-discovers the first model from the running server's /v1/models.
 */
export const DEFAULT_CONFIG: Config = {
  baseUrl: "http://localhost:8080",
  model: null,
  apiKey: "",
  temperature: 0.2,
  maxContext: 8192,
  compactThreshold: 0.8,
  compactKeepMessages: 6,
  commandTimeoutMs: 60000,
  maxToolOutputChars: 20000,
  systemPrompt: null,
  parallelToolCalls: true,
  shell: "auto",
  maxIterations: null,
};

/** Map of config key -> environment variable name (spec §6.1). */
export const ENV_KEYS: Record<keyof Config, string> = {
  baseUrl: "HARNESS_BASE_URL",
  model: "HARNESS_MODEL",
  apiKey: "HARNESS_API_KEY",
  temperature: "HARNESS_TEMPERATURE",
  maxContext: "HARNESS_MAX_CONTEXT",
  compactThreshold: "HARNESS_COMPACT_THRESHOLD",
  compactKeepMessages: "HARNESS_COMPACT_KEEP",
  commandTimeoutMs: "HARNESS_COMMAND_TIMEOUT_MS",
  maxToolOutputChars: "HARNESS_MAX_TOOL_OUTPUT",
  systemPrompt: "HARNESS_SYSTEM_PROMPT",
  parallelToolCalls: "HARNESS_PARALLEL_TOOLS",
  shell: "HARNESS_SHELL",
  maxIterations: "HARNESS_MAX_ITERATIONS",
};

/** The set of valid config keys, used for unknown-key detection. */
export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];
