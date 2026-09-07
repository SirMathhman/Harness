/**
 * Core domain types for the Vise agent runtime.
 * Mirrors §2 of SPECIFICATION.md.
 */
import type { HookManager } from "./hooks/manager.js";

/** Roles allowed on a chat message (OpenAI chat format). */
export type Role = "system" | "user" | "assistant" | "tool";

/** A single entry in the conversation, in OpenAI chat-completions format. */
export interface Message {
  role: Role;
  /** Text content. May be null/empty for tool-call-only assistant messages. */
  content: string | null;
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCall[];
  /** Present on `tool` messages; matches the originating ToolCall id. */
  tool_call_id?: string;
  /** Present on `tool` messages; the name of the tool that produced the result. */
  name?: string;
}

/** A request from the model to run a tool. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON object of arguments (parsed). */
  arguments: Record<string, unknown>;
}

/** The outcome of executing a tool, fed back as a `tool` Message. */
export interface ToolResult {
  tool_call_id: string;
  content: string;
}

/** A callable capability exposed to the model. */
export interface Tool {
  name: string;
  /** JSON-schema description of the tool's parameters. */
  parameters: JsonSchema;
  /** Whether the tool mutates state (affects execution ordering). */
  mutating: boolean;
  /** Human-readable one-line description shown to the model. */
  description: string;
  /** Execute the tool. Must return a string (success output or error text). */
  handler(args: Record<string, unknown>): Promise<string>;
  /**
   * When true, the tool's result is not truncated to `maxToolOutputChars`
   * (skills spec §3.5). Used by `read_skill`, whose result *is* the
   * knowledge payload — truncating it would defeat the purpose.
   */
  noTruncate?: boolean;
}

/**
 * A named body of deferred context (skills spec §2.1).
 *
 * Only the `name` and `description` live in the system prompt (the skill
 * index); the `text` is loaded on demand by the `read_skill` tool. Skills are
 * a side-channel on the `ResourceGraph`, like providers: they are not graph
 * nodes, have no `ResourceId`, and are global to the session.
 */
export interface Skill {
  /** Unique, non-empty name. */
  name: string;
  /** One-line summary for the skill index. */
  description: string;
  /** The full body, loaded on demand via `read_skill`. */
  text: string;
  /** Which config file created this skill. */
  origin: "global" | "project";
}

/** Minimal JSON-schema shape used for tool parameter declarations. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object";
  description?: string;
  enum?: (string | number)[];
  default?: unknown;
}

/** A shell command running asynchronously. */
export interface BackgroundCommand {
  id: string;
  status: "running" | "exited";
  exitCode?: number;
  stdout: string;
  stderr: string;
}

/**
 * The resolved settings one agent (or subagent) runs under: the non-graph
 * runtime settings merged with the parameters of the profile's model
 * (profiles spec §3.5).
 */
export interface Config {
  baseUrl: string;
  model: string | null;
  apiKey: string;
  temperature: number;
  /**
   * A user-pinned context window, or `null` to trust the backend.
   *
   * The real window is a property of a *loaded* model on a server, not of a
   * model definition, so it is not resolved from the graph. `null` means the
   * session discovers it at runtime (`Session.contextWindow`); a number here
   * overrides whatever the server reports.
   */
  contextWindow: number | null;
  compactThreshold: number;
  compactKeepMessages: number;
  commandTimeoutMs: number;
  maxToolOutputChars: number;
  systemPrompt: string | null;
  parallelToolCalls: boolean;
  shell: string;
  maxIterations: number | null;
  /**
   * When true, Vise advertises a constant, minimal tool surface
   * (search_tools + call_tool + core tools) and exposes the rest of the
   * catalog on demand, keeping the request prefix stable for KV-cache reuse
   * (spec §3.3.1).
   */
  dynamicTools: boolean;
  /**
   * Hard ceiling on a subagent's iteration budget; the effective cap is
   * `min(requested, this)` (spec §3.8.4).
   */
  subagentMaxIterations: number;
  /**
   * Global backstop on subagent nesting, applied to any profile that sets no
   * `subagent.maxDepth` of its own (profiles spec §3.12.3).
   */
  maxSubagentDepth: number;
}

/** One REPL invocation. Holds the running conversation. */
export interface Session {
  messages: Message[];
  config: Config;
  /** prompt_tokens from the most recent LLM call (for compaction). */
  lastPromptTokens: number | null;
  /**
   * The context window this session is actually running against, in tokens,
   * or `null` while it is still unknown.
   *
   * Observed state, not configuration: a lazily-loading backend (a llama.cpp
   * router) only knows a model's window once the model is loaded, so the value
   * is seeded from `config.contextWindow` and otherwise filled in by
   * `probeContextWindow` after the first completion. Compaction is disabled
   * while it is `null` — there is no threshold to compare against.
   */
  contextWindow: number | null;
  /**
   * Ask the backend what context window the active model is running with.
   *
   * Resolves to `null` when the backend cannot say (yet). Set by
   * `materializeProfile` from the active model's provider; absent for a model
   * with no provider, which can only be pinned via `config.contextWindow`.
   */
  probeContextWindow?: () => Promise<number | null>;
  /** The lifecycle hooks this session dispatches to (hooks spec §2.2). */
  hooks: HookManager;
  /** Subagent nesting depth; 0 for the main session (hooks spec §3.7). */
  depth: number;
  /**
   * The name of the profile this session is running under; `"Agent"` for the
   * implicit default profile (config spec §3.7).
   */
  profile: string;
}

/** Token usage reported by the LLM on the final stream chunk. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** The fully accumulated result of one streamed LLM call. */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
}
