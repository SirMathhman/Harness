/**
 * The profiles & resource-graph domain types (profiles spec §2, §3.3).
 *
 * A Vise configuration is a directed graph. Nodes are *resources* (profiles,
 * hooks, tools, models); edges are *connections*. Resolving a profile means
 * walking its outgoing edges to collect the system prompt, tool set, hook set,
 * and model that the agent runs under.
 */
import type { Hook } from "../hooks/types.js";
import type { Tool } from "../types.js";

/**
 * An opaque handle to a resource in the graph (profiles spec §5).
 *
 * The brand makes the type unforgeable from user code: an id can only be
 * obtained from a `Registry.create*` call or from `Registry.builtins`, so a
 * connection can never reference a resource that does not exist.
 */
declare const RESOURCE_ID: unique symbol;
export type ResourceId = string & { readonly [RESOURCE_ID]: "vise.resource" };

/** Reads a `ResourceId` back as the plain string it is underneath. */
export function idString(id: ResourceId): string {
  return id as string;
}

/** Wraps a raw string as a `ResourceId`. Internal to the registry. */
export function asResourceId(raw: string): ResourceId {
  return raw as ResourceId;
}

/** The four kinds of node in the resource graph (profiles spec §2.2). */
export type ResourceKind = "profile" | "hook" | "tool" | "model";

/** Constraints a profile places on the subagents it spawns (spec §3.12). */
export interface SubagentPolicy {
  /**
   * Which profiles subagents may run under. Omitted → any defined profile is
   * allowed for the `profile` parameter of `spawn_subagent`.
   */
  profiles?: string[];
  /**
   * Maximum nesting depth for subagents. `0` forbids them outright; `1` allows
   * one level, and so on. A spawn is rejected when `currentDepth + 1 > maxDepth`
   * (spec §3.12.3). Omitted → the global `maxSubagentDepth` backstop applies.
   */
  maxDepth?: number;
}

/** A named agent configuration (spec §3.3). */
export interface ProfileDef {
  /** Unique, non-empty name; the argument to `/profile <name>`. */
  name: string;
  /** System prompt for this profile. Empty string → the built-in default. */
  systemPrompt: string;
  /** Constraints on subagents spawned by this profile. */
  subagent?: SubagentPolicy;
}

/** A lifecycle handler, identical in shape to a hook-file entry. */
export type HookDef = Hook;

/** A user-defined tool, identical in shape to a built-in `Tool`. */
export type ToolDef = Tool;

/** An LLM endpoint (spec §3.3). */
export interface ModelDef {
  /** The model identifier, e.g. `llama-3-70b`. */
  name: string;
  /** Base URL of the LLM server. */
  baseUrl: string;
  /** API key; may be empty for local servers. */
  apiKey: string;
  /** Default sampling temperature. A connection prop can override it. */
  temperature?: number;
  /** Context-window size in tokens. A connection prop can override it. */
  maxContext?: number;
}

/**
 * The runtime knobs that are not modelled as resources (§3.2, `setRuntime`).
 *
 * Everything here is global to the session rather than per-profile: the
 * resource graph carries the system prompt, tools, hooks, and model, and these
 * settings carry the rest of what the agent loop needs.
 */
export interface RuntimeSettings {
  /** Fraction of the context window that triggers compaction, in (0, 1]. */
  compactThreshold: number;
  /** How many recent messages compaction keeps verbatim. */
  compactKeepMessages: number;
  /** Timeout for a foreground `run_command`, in milliseconds. */
  commandTimeoutMs: number;
  /** Hard cap on the characters of any single tool result. */
  maxToolOutputChars: number;
  /** Whether the model may request several tool calls per message. */
  parallelToolCalls: boolean;
  /** Shell used by `run_command`; `"auto"` picks one per platform. */
  shell: string;
  /** Cap on tool-call iterations per turn; `null` for no cap. */
  maxIterations: number | null;
  /** Advertise a constant minimal tool surface plus `search_tools`/`call_tool`. */
  dynamicTools: boolean;
  /** Ceiling on a subagent's iteration budget. */
  subagentMaxIterations: number;
  /**
   * Global backstop on subagent nesting, used for any profile that does not
   * set `subagent.maxDepth` of its own (spec §3.12.3, "same as current
   * behavior").
   */
  maxSubagentDepth: number;
}

/** A directed edge between two resources (spec §3.4). */
export interface Connection {
  from: ResourceId;
  to: ResourceId;
  props?: Record<string, unknown>;
}

/** How `/profile <name>` rewrites the conversation's system message (§3.6). */
export type ProfileSwitchMode = "replace" | "append";

/**
 * The configuration surface handed to `.vise/index.ts` (spec §3.2).
 *
 * Every method is synchronous and side-effect-free outside the registry, so a
 * config module is a pure description of the graph.
 */
export interface Registry {
  /** Create a profile resource. Returns its id. */
  createProfile(def: ProfileDef): ResourceId;
  /** Create a hook resource. Returns its id. */
  createHook(def: HookDef): ResourceId;
  /** Create a custom tool resource. Returns its id. */
  createTool(def: ToolDef): ResourceId;
  /** Create a model resource. Returns its id. */
  createModel(def: ModelDef): ResourceId;
  /** Create a directed connection between two resources. */
  createConnection(
    from: ResourceId,
    to: ResourceId,
    props?: Record<string, unknown>,
  ): void;
  /** Set how a profile switch rewrites the system message. Default `replace`. */
  setProfileSwitchMode(mode: ProfileSwitchMode): void;
  /** Override the non-graph runtime settings. Merged over the defaults. */
  setRuntime(settings: Partial<RuntimeSettings>): void;
  /** Well-known ids for the built-in resources. */
  builtins: {
    /** Every built-in tool, keyed by tool name. */
    tools: Record<string, ResourceId>;
    /** The model used by any profile with no model edge. */
    defaultModel: ResourceId;
    /** The implicit profile used when the config defines none. */
    defaultProfile: ResourceId;
  };
}

/** A config module's default export (spec §3.1). */
export type ViseConfig = (reg: Registry) => void;

/** A resource node, discriminated by kind. */
export type Resource =
  | { kind: "profile"; id: ResourceId; def: ProfileDef; implicit: boolean }
  | { kind: "hook"; id: ResourceId; def: HookDef; source: string }
  | { kind: "tool"; id: ResourceId; name: string; def: ToolDef | null }
  | { kind: "model"; id: ResourceId; def: ModelDef; builtin: boolean };
