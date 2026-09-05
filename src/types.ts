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
  maxContext: number;
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
