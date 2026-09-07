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
import type { Provider } from "../providers/types.js";

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

/**
 * Which config file created a resource (config spec §2.1, §3.2).
 *
 * `"builtin"` covers the implicit default profile, the default model, and the
 * built-in tool placeholders — none of which came from either config file.
 */
export type ResourceOrigin = "global" | "project" | "builtin";

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

/** A named agent configuration (spec §3.3; providers spec §3.3). */
export interface ProfileDef {
  /** Unique, non-empty name; the argument to `/profile <name>`. */
  name: string;
  /** System prompt for this profile. Empty string → the built-in default. */
  systemPrompt: string;
  /** Constraints on subagents spawned by this profile. */
  subagent?: SubagentPolicy;
  /**
   * A whitelist of models available to this profile (providers spec §3.4).
   * Omitted or empty → all discovered/declared models are available.
   */
  models?: ModelSelection;
}

/**
 * A whitelist of models available to a profile (providers spec §3.4).
 *
 * Each element is either:
 * - `string`: a provider name. All models from that provider are included.
 * - `[string, string]`: a tuple of `[providerName, modelRegex]`. Only models
 *   from that provider whose name matches the regex are included (full-string
 *   match, i.e. `^regex$`).
 *
 * The whitelist is a filter: it restricts which models are available, it does
 * not create or configure them. A model with no `provider` (declared via
 * `reg.createModel()`) can never match a whitelist element — it is only ever
 * reachable through a `Profile → Model` connection (providers spec §3.5).
 *
 * If the array is missing or empty, all discovered/declared models are
 * available (no filtering).
 */
export type ModelSelection = (string | [string, string])[];

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
  /**
   * The `ResourceId` of the `Provider` that discovered this model (providers
   * spec §3.3). Set by the harness at startup; never set by the config
   * function. `undefined` for a model declared directly via
   * `reg.createModel()`. Used to disambiguate models that share a name
   * across providers, and to test a profile's `models` whitelist.
   */
  provider?: ResourceId;
}

/**
 * The runtime knobs that are not modelled as resources (§3.2, `setRuntime`).
 *
 * Everything here is global to the session rather than per-profile: the
 * resource graph carries the system prompt, tools, hooks, and model, and these
 * settings carry the rest of what the agent loop needs.
 */
export interface RuntimeSettings {
  /**
   * Pin the context window, in tokens, instead of believing the backend.
   *
   * `null` (the default) means "ask the server": the window is a property of
   * a *loaded* model, not of a model definition, so Vise discovers it at
   * runtime through `Provider.contextWindow()` (v0.9.0 spec §2, §3). Set a
   * number here only for a backend that never reports one.
   */
  contextWindow: number | null;
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
  /**
   * How `/profile <name>` rewrites the conversation's system message
   * (config spec §3.5). Formerly a separate `setProfileSwitchMode` method.
   */
  profileSwitchMode: ProfileSwitchMode;
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
  /**
   * Register a provider with the registry (providers spec §3.3). The
   * provider is stored in a side-channel — not a graph node — and is queried
   * at startup to discover models.
   *
   * If `provider.name` is empty, the registry assigns an auto-generated name
   * (e.g. `"llama_0"`) and sets it on the provider.
   *
   * @returns The provider's `ResourceId`, used as the `provider` field on the
   *   `Model` resources created from what it discovers.
   * @throws if a provider with the same (explicit or auto-generated) name is
   *   already registered.
   */
  addProvider(provider: Provider): ResourceId;
  /**
   * Look up a provider by name (providers spec §3.3). Returns `undefined` if
   * no provider with that name is registered.
   */
  getProvider(name: string): ResourceId | undefined;
  /**
   * Create a skill — a named body of deferred context (skills spec §3.1).
   *
   * Skills are a side-channel, not graph nodes: they have no `ResourceId`,
   * cannot be connected to a profile, and are visible to every agent at every
   * depth. Only `name` and `description` reach the system prompt (the skill
   * index); the model pulls `text` in on demand with the `read_skill` tool.
   *
   * @param name        Unique, non-empty name. Any non-empty string is valid;
   *                    there is no character-set restriction.
   * @param description One-line summary shown in the skill index and returned
   *                    by `list_skills`. The model reads it to decide whether
   *                    the skill is worth loading.
   * @param text        The full body. Returned verbatim by `read_skill`,
   *                    never truncated to `maxToolOutputChars`.
   *
   * @throws if `name` is empty, or if a skill with the same name was already
   *   created — in this file or in the other config file. Either is a fatal
   *   config error naming the duplicate.
   */
  createSkill(name: string, description: string, text: string): void;
  /** Create a directed connection between two resources. */
  createConnection(
    from: ResourceId,
    to: ResourceId,
    props?: Record<string, unknown>,
  ): void;
  /** Override the non-graph runtime settings. Merged over the defaults. */
  setRuntime(settings: Partial<RuntimeSettings>): void;
  /**
   * Look up a profile by name (config spec §3.4). Searches every profile in
   * the combined graph — global, project, and the implicit built-in.
   * Returns `undefined` if not found.
   */
  getProfile(name: string): ResourceId | undefined;
  /**
   * Look up a model by name (config spec §3.4). Returns `undefined` if not
   * found; a model created with an empty (auto-discovered) name is never
   * matched.
   */
  getModel(name: string): ResourceId | undefined;
  /**
   * Look up a tool by name, built-in or custom (config spec §3.4). Returns
   * `undefined` if not found.
   */
  getTool(name: string): ResourceId | undefined;
  /** Well-known ids for the built-in resources. */
  builtins: {
    /** Every built-in tool, keyed by tool name. */
    tools: Record<string, ResourceId>;
    /** The implicit profile used when the config defines none. */
    defaultProfile: ResourceId;
    /**
     * Every registered provider, keyed by name (providers spec §3.3).
     * Populated as providers are added via `addProvider()`. There is no
     * built-in default model: with no provider registered, Vise exits with a
     * fatal error at startup rather than falling back to one.
     */
    providers: Record<string, ResourceId>;
  };
}

/** A config module's default export (spec §3.1). */
export type ViseConfig = (reg: Registry) => void;

/** A resource node, discriminated by kind. Every node carries its origin. */
export type Resource =
  | {
      kind: "profile";
      id: ResourceId;
      def: ProfileDef;
      implicit: boolean;
      origin: ResourceOrigin;
    }
  | { kind: "hook"; id: ResourceId; def: HookDef; source: string; origin: ResourceOrigin }
  | {
      kind: "tool";
      id: ResourceId;
      name: string;
      def: ToolDef | null;
      origin: ResourceOrigin;
    }
  | {
      kind: "model";
      id: ResourceId;
      def: ModelDef;
      /**
       * True for a `Model` resource created by the harness from provider
       * discovery at startup (providers spec §3.6); false for one declared
       * directly via `reg.createModel()`.
       */
      discovered: boolean;
      origin: ResourceOrigin;
    };
