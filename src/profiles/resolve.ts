import type { Config, Tool } from "../types.js";
import type { RegisteredHook } from "../hooks/manager.js";
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from "../config/defaults.js";
import { IMPLICIT_PROFILE_NAME, type ResourceGraph } from "./registry.js";
import {
  idString,
  type Connection,
  type ModelDef,
  type ModelSelection,
  type Resource,
  type ResourceId,
  type ResourceOrigin,
  type SubagentPolicy,
} from "./types.js";

/** Raised when `/profile <name>` or `spawn_subagent` names an unknown profile. */
export class UnknownProfileError extends Error {
  constructor(
    readonly profileName: string,
    known: readonly string[],
  ) {
    super(
      known.length === 0
        ? `Unknown profile "${profileName}". No profiles are defined.`
        : `Unknown profile "${profileName}". Available: ${known.join(", ")}.`,
    );
  }
}

/**
 * Raised when a profile resolves to no usable model, which the agent loop
 * cannot run against (profiles spec §3.11; providers spec §3.11).
 *
 * At startup this is fatal; on a `/profile` switch it aborts the switch and
 * leaves the session on the profile it was already using.
 */
export class ProfileHasNoModelError extends Error {
  constructor(readonly profileName: string) {
    super(
      `Profile "${profileName}" has no model. Connect a Model resource to it ` +
        `in ./.vise/index.ts, or register a provider in .vise/index.ts so a ` +
        `model can be discovered (e.g. reg.addProvider(new LlamaProvider({ ` +
        `url: "http://localhost:8080" }))).`,
    );
  }
}

/**
 * Raised when a resolved model reports no context-window size: no connection
 * prop, no `maxContext` on the model definition, and (for a provider-
 * discovered model) no usable value from discovery. There is no built-in
 * default to fall back to (providers spec §3.11) — compaction has no
 * threshold to compare prompt-token counts against without a real number, so
 * this is fatal rather than a silent guess.
 */
export class MissingMaxContextError extends Error {
  constructor(
    readonly modelName: string,
    readonly baseUrl: string,
  ) {
    super(
      `Model "${modelName}" (${baseUrl}) has no context-window size. Set ` +
        `"maxContext" on it — via reg.createModel({ ..., maxContext: N }) or a ` +
        `Profile→Model connection prop — or use a provider that reports one ` +
        `(a llama.cpp server exposes it as meta.n_ctx on GET /v1/models).`,
    );
  }
}

/**
 * Everything a session needs to run under one profile (profiles spec §3.5).
 * Produced purely from a `ResourceGraph` plus a profile name (and, for model
 * selection, the options below) — no I/O, no side effects — so switching
 * profiles is just re-resolving.
 */
export interface ResolvedProfile {
  /** The profile's name; `""` for the implicit default. */
  name: string;
  /** The resolved runtime + model configuration for the agent loop. */
  config: Config;
  /**
   * The Model resource this profile resolved to, or `null` when it has no
   * usable model (providers spec §3.11).
   */
  modelId: ResourceId | null;
  /**
   * The models available to this profile after `models` whitelist filtering
   * (providers spec §3.4), in discovery order. Every model when the profile
   * declares no whitelist.
   */
  availableModelIds: ResourceId[];
  /**
   * The built-in tools this profile may use, or `null` when the profile has no
   * tool edges at all — which means *every* built-in tool (spec §3.5 rule 2).
   */
  builtinTools: string[] | null;
  /** The custom tools connected to this profile. Never implicit. */
  customTools: Tool[];
  /** The hooks connected to this profile, with their tool filters applied. */
  hooks: RegisteredHook[];
  /** The profile's subagent policy, if it declared one. */
  subagent: SubagentPolicy | undefined;
}

/**
 * The profile a session starts under when nothing else says otherwise
 * (config spec §3.7): always the implicit built-in profile. Naming a profile
 * `"default"` no longer has any special effect — the only way to start under
 * a specific profile is to pass one explicitly, or to restore one from the
 * state file (see `resolveStartingProfile` in `state.ts`).
 */
export function defaultProfileName(graph: ResourceGraph): string {
  void graph;
  return IMPLICIT_PROFILE_NAME;
}

/** Every user-defined profile name, in creation order (for `/profile`). */
export function profileNames(graph: ResourceGraph): string[] {
  const names: string[] = [];
  for (const resource of graph.resources.values()) {
    if (resource.kind === "profile" && !resource.implicit) {
      names.push(resource.def.name);
    }
  }
  return names;
}

/** One row of the `/profile` listing (config spec §3.9): a name and its origin. */
export interface ProfileEntry {
  name: string;
  origin: ResourceOrigin;
}

/**
 * Every profile in the graph, including the implicit built-in one, in
 * creation order: builtin, then global, then project (config spec §3.9).
 * Creation order matches this automatically — the implicit profile is
 * inserted before any config runs, and the global file runs before the
 * project file (§3.2).
 */
export function profileEntries(graph: ResourceGraph): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  for (const resource of graph.resources.values()) {
    if (resource.kind === "profile") {
      entries.push({ name: resource.def.name, origin: resource.origin });
    }
  }
  return entries;
}

/**
 * Raised when `/model <name>` (or `<provider>/<name>`) names no known model
 * (providers spec §3.8, §4 E-P7's sibling "no match" case).
 */
export class UnknownModelError extends Error {
  constructor(readonly modelName: string) {
    super(`Unknown model "${modelName}".`);
  }
}

/**
 * Raised when a bare `/model <name>` matches more than one provider
 * (providers spec §4, E-P6).
 */
export class AmbiguousModelError extends Error {
  constructor(
    readonly modelName: string,
    readonly providers: readonly string[],
  ) {
    super(
      `Model '${modelName}' is ambiguous. Use '<provider>/<name>' to ` +
        `disambiguate. Providers: ${providers.join(", ")}.`,
    );
  }
}

/**
 * Raised when `/model` targets a model outside the active profile's
 * `models` whitelist (providers spec §4, E-P7).
 */
export class ModelNotAvailableError extends Error {
  constructor(
    readonly modelName: string,
    readonly profileName: string,
    available: readonly string[],
  ) {
    super(
      `Model '${modelName}' is not available for profile '${profileName}'. ` +
        `Available: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
    );
  }
}

/** One model in the graph, ready for `/model` listing or lookup (providers spec §3.8). */
export interface ModelListEntry {
  id: ResourceId;
  name: string;
  baseUrl: string;
  /** The provider that discovered it, or `null` for an explicit `reg.createModel()` model. */
  providerName: string | null;
}

/**
 * Every model in the graph — config-declared or provider-discovered — in
 * creation/discovery order (providers spec §3.8). A model with an empty name
 * (legacy `reg.createModel({ name: "" })`) is excluded: it can never be
 * addressed by name.
 */
export function allModelEntries(graph: ResourceGraph): ModelListEntry[] {
  const out: ModelListEntry[] = [];
  for (const [id, resource] of graph.resources) {
    if (resource.kind !== "model" || resource.def.name === "") continue;
    const providerName =
      resource.def.provider !== undefined
        ? (graph.providers.get(resource.def.provider)?.name ?? null)
        : null;
    out.push({
      id,
      name: resource.def.name,
      baseUrl: resource.def.baseUrl,
      providerName,
    });
  }
  return out;
}

/**
 * Every model matching `ref`: a bare model name, or `<provider>/<name>`
 * (providers spec §3.8). A bare name can match more than one entry when
 * several providers serve a model with that name (E-P6).
 *
 * A `ref` containing `/` is first tried as an exact model name — model names
 * themselves may contain slashes (e.g. HF-style `repo/file` ids) — and only
 * falls back to the `<provider>/<name>` split when nothing matches exactly.
 */
export function findModelsByRef(
  graph: ResourceGraph,
  ref: string,
): ModelListEntry[] {
  const exact = allModelEntries(graph).filter((e) => e.name === ref);
  if (exact.length > 0) return exact;

  const slash = ref.indexOf("/");
  if (slash > 0) {
    const providerName = ref.slice(0, slash);
    const modelName = ref.slice(slash + 1);
    return allModelEntries(graph).filter(
      (e) => e.providerName === providerName && e.name === modelName,
    );
  }
  return allModelEntries(graph).filter((e) => e.name === ref);
}

/** The `ResourceId`s of every named Model resource, in creation/discovery order. */
function allModelIds(graph: ResourceGraph): ResourceId[] {
  const out: ResourceId[] = [];
  for (const [id, resource] of graph.resources) {
    if (resource.kind === "model" && resource.def.name !== "") out.push(id);
  }
  return out;
}

/**
 * The models available to a profile after `models` whitelist filtering
 * (providers spec §3.4). A missing or empty selection means every model in
 * the graph. A provider-less model (declared via `reg.createModel()`) can
 * never match a non-empty whitelist, since whitelist elements are always
 * provider references — it remains reachable only through a direct
 * `Profile → Model` connection.
 */
export function availableModelIds(
  graph: ResourceGraph,
  selection: ModelSelection | undefined,
): ResourceId[] {
  const all = allModelIds(graph);
  if (!selection || selection.length === 0) return all;

  const out: ResourceId[] = [];
  for (const id of all) {
    const resource = graph.resources.get(id);
    if (resource?.kind !== "model" || resource.def.provider === undefined) {
      continue;
    }
    const providerName = graph.providers.get(resource.def.provider)?.name;
    if (providerName === undefined) continue;

    for (const el of selection) {
      const [wantProvider, pattern] = typeof el === "string" ? [el, null] : el;
      if (wantProvider !== providerName) continue;
      if (pattern === null) {
        out.push(id);
        break;
      }
      let re: RegExp;
      try {
        re = new RegExp(`^(?:${pattern})$`);
      } catch {
        continue;
      }
      if (re.test(resource.def.name)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/** Options steering which model a resolved profile ends up with. */
export interface ResolveProfileModelOptions {
  /**
   * Use this model id verbatim, bypassing the `Profile → Model` connection
   * and whitelist logic entirely. Pass `null` for "no model". Used by
   * subagent spawn, which applies its own model-selection rules (providers
   * spec §3.7) instead of the ones below.
   */
  modelId?: ResourceId | null;
  /**
   * A model name to prefer when the profile has no `Profile → Model`
   * connection (the state file's `lastModel`, providers spec §3.4, §3.9).
   * Ignored when `modelId` is given.
   */
  modelNameHint?: string | null;
}

/**
 * Resolve a profile into the active configuration (profiles spec §3.5;
 * providers spec §3.4–§3.6).
 *
 * Traversal follows only the profile's *outgoing* edges, with a visited set so
 * a cyclic config cannot loop forever (spec §8, the DAG assumption).
 *
 * Model selection (when `modelOptions.modelId` is not given): a
 * `Profile → Model` connection wins outright; otherwise the profile's
 * `models` whitelist is filtered against every model in the graph, and the
 * active model is `modelNameHint` if it names one of the filtered models,
 * else the first of them, else `null` (no usable model).
 *
 * @throws UnknownProfileError when `name` names no profile in the graph.
 */
export function resolveProfile(
  graph: ResourceGraph,
  name: string,
  modelOptions: ResolveProfileModelOptions = {},
): ResolvedProfile {
  const profileId = graph.profiles.get(name);
  const profile = profileId && graph.resources.get(profileId);
  if (!profileId || !profile || profile.kind !== "profile") {
    throw new UnknownProfileError(name, profileNames(graph));
  }

  const outgoing = graph.edgesFrom.get(profileId) ?? [];
  const builtinTools: string[] = [];
  const customTools: Tool[] = [];
  const hooks: RegisteredHook[] = [];
  let hasToolEdge = false;
  let modelEdge: Connection | null = null;

  const seen = new Set<ResourceId>([profileId]);
  for (const edge of outgoing) {
    if (seen.has(edge.to)) continue;
    const target = graph.resources.get(edge.to);
    if (target === undefined) continue; // rejected by validation; ignore here
    seen.add(edge.to);

    switch (target.kind) {
      case "tool":
        hasToolEdge = true;
        if (target.def === null) builtinTools.push(target.name);
        else customTools.push(target.def);
        break;
      case "hook":
        hooks.push(registerHook(graph, target));
        break;
      case "model":
        // Spec §3.5 rule 4 names a single model per profile; the first edge
        // wins so a stray second one cannot silently change the endpoint.
        modelEdge ??= edge;
        break;
      case "profile":
        break; // rejected by validation; nothing to resolve
    }
  }

  const available = availableModelIds(graph, profile.def.models);

  let modelId: ResourceId | null;
  // The connection prop override (temperature/maxContext) only applies when
  // the connected model is the one actually in effect.
  let propsEdge: Connection | null = null;
  if (modelOptions.modelId !== undefined) {
    modelId = modelOptions.modelId;
  } else if (modelEdge !== null) {
    // A Profile → Model connection pins the model, overriding the whitelist's
    // active-model selection (providers spec §3.5). Validation (E-P5) already
    // rejects a connection to a model outside a non-empty whitelist.
    modelId = modelEdge.to;
    propsEdge = modelEdge;
  } else if (available.length === 0) {
    modelId = null;
  } else if (modelOptions.modelNameHint) {
    const hintName = modelOptions.modelNameHint;
    modelId =
      available.find((id) => nameOfModel(graph, id) === hintName) ??
      available[0];
  } else {
    modelId = available[0];
  }

  const model = modelId !== null ? modelDefOf(graph, modelId) : NO_MODEL_DEF;
  const systemPrompt =
    profile.def.systemPrompt === "" ? null : profile.def.systemPrompt;

  // Connection props override the model's own parameters (spec §3.5); there
  // is no further fallback for maxContext — a resolved model that still has
  // none is a fatal MissingMaxContextError (providers spec §3.11).
  const maxContext = numberProp(propsEdge, "maxContext") ?? model.maxContext;
  if (modelId !== null && maxContext === undefined) {
    throw new MissingMaxContextError(model.name, model.baseUrl);
  }

  return {
    name,
    modelId,
    availableModelIds: available,
    config: {
      ...graph.runtime,
      baseUrl: model.baseUrl,
      model: model.name === "" ? null : model.name,
      apiKey: model.apiKey,
      temperature:
        numberProp(propsEdge, "temperature") ??
        model.temperature ??
        DEFAULT_CONFIG.temperature,
      // No model resolved (modelId === null): the caller must already treat
      // this as fatal (ProfileHasNoModelError) before running a turn, so 0 is
      // an inert placeholder, never an assumed context size.
      maxContext: maxContext ?? 0,
      systemPrompt,
    },
    builtinTools: hasToolEdge ? builtinTools : null,
    customTools,
    hooks,
    subagent: profile.def.subagent,
  };
}

/** The system prompt a resolved profile actually runs with. */
export function systemPromptOf(resolved: ResolvedProfile): string {
  return resolved.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
}

/**
 * Turn a hook resource into a `RegisteredHook`, attaching the tool names from
 * its Hook→Tool edges as a firing filter (spec §3.7). A hook with no such
 * edges fires for every tool.
 */
function registerHook(
  graph: ResourceGraph,
  hook: Extract<Resource, { kind: "hook" }>,
): RegisteredHook {
  const tools: string[] = [];
  for (const edge of graph.edgesFrom.get(hook.id) ?? []) {
    const target = graph.resources.get(edge.to);
    if (target?.kind === "tool") tools.push(target.name);
  }
  return {
    hook: hook.def,
    source: idString(hook.id),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** The sentinel `ModelDef` for "no model resolved". */
const NO_MODEL_DEF: ModelDef = { name: "", baseUrl: "", apiKey: "" };

/** The `ModelDef` behind a resource id, or the "no model" sentinel. */
function modelDefOf(graph: ResourceGraph, id: ResourceId): ModelDef {
  const resource = graph.resources.get(id);
  return resource?.kind === "model" ? resource.def : NO_MODEL_DEF;
}

/** The `name` of the Model resource behind `id`, or `undefined`. */
function nameOfModel(graph: ResourceGraph, id: ResourceId): string | undefined {
  const resource = graph.resources.get(id);
  return resource?.kind === "model" ? resource.def.name : undefined;
}

/** Read a numeric override off a connection's props, if it has one. */
function numberProp(edge: Connection | null, key: string): number | undefined {
  const value = edge?.props?.[key];
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}
