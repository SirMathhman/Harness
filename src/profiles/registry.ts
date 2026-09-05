import { BUILTIN_TOOL_NAMES } from "../tools/names.js";
import { DEFAULT_RUNTIME } from "../config/defaults.js";
import {
  asResourceId,
  idString,
  type Connection,
  type HookDef,
  type ModelDef,
  type ProfileDef,
  type Registry,
  type Resource,
  type ResourceId,
  type ResourceOrigin,
  type RuntimeSettings,
  type ToolDef,
} from "./types.js";

/** The id of the implicit profile used when the config defines none (§3.8). */
export const IMPLICIT_PROFILE_ID = asResourceId("builtin:profile:default");

/** The id of the model every profile falls back to when it has no model edge. */
export const DEFAULT_MODEL_ID = asResourceId("builtin:model:default");

/**
 * The name of the implicit built-in profile (config spec §3.7). Reserved: a
 * user-defined profile in either config file cannot use this name.
 */
export const IMPLICIT_PROFILE_NAME = "Agent";

/** Base URL used by the default model until the config overrides it. */
export const DEFAULT_BASE_URL = "http://localhost:8080";

/**
 * The finished, immutable description of a session's configuration: every
 * resource, every edge, and the settings that live outside the graph.
 *
 * Resolution (see `resolve.ts`) is a pure function of this value plus a profile
 * name, so a graph can be built once and re-resolved on every `/profile`
 * switch at no cost.
 */
export interface ResourceGraph {
  /** Every resource, keyed by id. */
  resources: ReadonlyMap<ResourceId, Resource>;
  /** Every connection, in creation order. */
  connections: readonly Connection[];
  /** Outgoing edges, keyed by source id. */
  edgesFrom: ReadonlyMap<ResourceId, readonly Connection[]>;
  /** Profile resources keyed by name, including the implicit default. */
  profiles: ReadonlyMap<string, ResourceId>;
  /**
   * The non-graph runtime settings, including `profileSwitchMode` (config
   * spec §3.5) — how `/profile` rewrites the system message.
   */
  runtime: RuntimeSettings;
}

/**
 * The concrete `Registry` handed to a `.vise/index.ts` config function
 * (profiles spec §3.2).
 *
 * It is a plain accumulator: `create*` appends a node, `createConnection`
 * appends an edge, and `build()` freezes the result into a `ResourceGraph`.
 * Nothing is validated here — validation runs once over the finished graph
 * (§3.11) so a config module can create resources in any order.
 */
export class ViseRegistry implements Registry {
  private readonly nodes = new Map<ResourceId, Resource>();
  private readonly edges: Connection[] = [];
  private readonly counters = new Map<string, number>();
  private runtime: RuntimeSettings = { ...DEFAULT_RUNTIME };

  /**
   * Which file is currently calling `create*` (config spec §3.2). Defaults to
   * `"project"` so a bare `new ViseRegistry()` — used by `buildGraphFrom` and
   * every single-file test — behaves exactly like the project tier always
   * has. The two-tier loader (`load.ts`) flips this with `setOrigin` around
   * each file's config call.
   */
  private origin: ResourceOrigin = "project";

  /** O(1) name-lookup indexes backing `getProfile`/`getModel`/`getTool`. */
  private readonly profilesByName = new Map<string, ResourceId>();
  private readonly modelsByName = new Map<string, ResourceId>();
  private readonly toolsByName = new Map<string, ResourceId>();

  readonly builtins: Registry["builtins"];

  constructor() {
    // The implicit default profile (§3.8, config spec §3.7). It is always
    // present so a config can attach resources to the fallback profile, and
    // it is only *selected* by default when no saved profile is restored
    // from the state file (config spec §3.7).
    this.nodes.set(IMPLICIT_PROFILE_ID, {
      kind: "profile",
      id: IMPLICIT_PROFILE_ID,
      def: { name: IMPLICIT_PROFILE_NAME, systemPrompt: "" },
      implicit: true,
      origin: "builtin",
    });
    this.profilesByName.set(IMPLICIT_PROFILE_NAME, IMPLICIT_PROFILE_ID);

    // The default model. Its `name` starts empty and is filled in by model
    // auto-discovery at startup unless the config replaces it (§3.10).
    this.nodes.set(DEFAULT_MODEL_ID, {
      kind: "model",
      id: DEFAULT_MODEL_ID,
      def: { name: "", baseUrl: DEFAULT_BASE_URL, apiKey: "" },
      builtin: true,
      origin: "builtin",
    });

    // Built-in tools are pre-registered as *placeholder* nodes: the graph only
    // needs their names, because the real `Tool` objects are constructed per
    // session from the resolved config.
    const tools: Record<string, ResourceId> = {};
    for (const name of BUILTIN_TOOL_NAMES) {
      const id = asResourceId(`builtin:${name}`);
      this.nodes.set(id, { kind: "tool", id, name, def: null, origin: "builtin" });
      this.toolsByName.set(name, id);
      tools[name] = id;
    }

    this.builtins = {
      tools,
      defaultModel: DEFAULT_MODEL_ID,
      defaultProfile: IMPLICIT_PROFILE_ID,
    };
  }

  /**
   * Tag every resource created from now on with `origin` (config spec §3.2).
   * Internal to the loader — not part of the public `Registry` a config
   * function sees, so a config module can never call it itself.
   */
  setOrigin(origin: ResourceOrigin): void {
    this.origin = origin;
  }

  createProfile(def: ProfileDef): ResourceId {
    const id = this.nextId("profile");
    this.nodes.set(id, { kind: "profile", id, def, implicit: false, origin: this.origin });
    if (typeof def?.name === "string") this.profilesByName.set(def.name, id);
    return id;
  }

  createHook(def: HookDef): ResourceId {
    const id = this.nextId("hook");
    this.nodes.set(id, {
      kind: "hook",
      id,
      def,
      source: idString(id),
      origin: this.origin,
    });
    return id;
  }

  createTool(def: ToolDef): ResourceId {
    const id = this.nextId("tool");
    const name = def?.name ?? "";
    this.nodes.set(id, { kind: "tool", id, name, def, origin: this.origin });
    if (name !== "") this.toolsByName.set(name, id);
    return id;
  }

  createModel(def: ModelDef): ResourceId {
    const id = this.nextId("model");
    this.nodes.set(id, { kind: "model", id, def, builtin: false, origin: this.origin });
    if (typeof def?.name === "string" && def.name !== "") {
      this.modelsByName.set(def.name, id);
    }
    return id;
  }

  createConnection(
    from: ResourceId,
    to: ResourceId,
    props?: Record<string, unknown>,
  ): void {
    assertResourceId(from, "from");
    assertResourceId(to, "to");
    this.edges.push(props === undefined ? { from, to } : { from, to, props });
  }

  getProfile(name: string): ResourceId | undefined {
    return this.profilesByName.get(name);
  }

  getModel(name: string): ResourceId | undefined {
    return this.modelsByName.get(name);
  }

  getTool(name: string): ResourceId | undefined {
    return this.toolsByName.get(name);
  }

  setRuntime(settings: Partial<RuntimeSettings>): void {
    // Explicit `undefined` values are ignored so a partial object literal with
    // an optional field never clears a default. Unknown keys are kept and
    // rejected by validation (§3.11), which can name them all at once.
    const target = this.runtime as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) target[key] = value;
    }
  }

  /** Freeze the accumulated resources and edges into a `ResourceGraph`. */
  build(): ResourceGraph {
    const edgesFrom = new Map<ResourceId, Connection[]>();
    for (const edge of this.edges) {
      const existing = edgesFrom.get(edge.from);
      if (existing) existing.push(edge);
      else edgesFrom.set(edge.from, [edge]);
    }

    const profiles = new Map<string, ResourceId>();
    for (const node of this.nodes.values()) {
      // A duplicate name would silently overwrite here; §3.11 rejects the
      // config before any of this is used.
      if (node.kind === "profile") profiles.set(node.def.name, node.id);
    }

    return {
      resources: this.nodes,
      connections: this.edges,
      edgesFrom,
      profiles,
      runtime: { ...this.runtime },
    };
  }

  /** `profile_0`, `hook_1`, … — unique per kind, stable across a build. */
  private nextId(kind: string): ResourceId {
    const n = this.counters.get(kind) ?? 0;
    this.counters.set(kind, n + 1);
    return asResourceId(`${kind}_${n}`);
  }
}

/**
 * Guard `createConnection` against an unchecked `getProfile`/`getModel`/
 * `getTool` lookup (config spec §3.4, C5/C6): those return `ResourceId |
 * undefined`, and a `ResourceId` is opaque, so the only way to catch a caller
 * that skipped the `undefined` check is at the point it is used.
 */
function assertResourceId(
  id: unknown,
  label: "from" | "to",
): asserts id is ResourceId {
  if (typeof id !== "string") {
    throw new Error(
      `createConnection: the "${label}" argument is not a valid ResourceId ` +
        `(got ${id === undefined ? "undefined" : JSON.stringify(id)}). This ` +
        `usually means a reg.getProfile()/getModel()/getTool() lookup returned ` +
        `undefined and was passed in without checking.`,
    );
  }
}

/**
 * The graph used when no `.vise/index.ts` exists (spec §3.8): the implicit
 * default profile, the default model, and no edges at all — which resolves to
 * every built-in tool, no hooks, and the built-in system prompt.
 */
export function defaultGraph(): ResourceGraph {
  return new ViseRegistry().build();
}

/**
 * Return a copy of `graph` in which model `id` carries `name`.
 *
 * Used once at startup after auto-discovery has asked the running server which
 * model it has loaded (spec §3.10): a Model resource with an empty `name` —
 * the built-in default among them — means "whatever this server has loaded".
 * Everything else is shared by reference; the graph is immutable, so this is
 * safe.
 */
export function withDiscoveredModel(
  graph: ResourceGraph,
  id: ResourceId,
  name: string,
): ResourceGraph {
  const existing = graph.resources.get(id);
  if (existing === undefined || existing.kind !== "model") return graph;
  const resources = new Map(graph.resources);
  resources.set(id, { ...existing, def: { ...existing.def, name } });
  return { ...graph, resources };
}
