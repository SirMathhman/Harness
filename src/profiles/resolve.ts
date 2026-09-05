import type { Config, Tool } from "../types.js";
import type { RegisteredHook } from "../hooks/manager.js";
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from "../config/defaults.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  IMPLICIT_PROFILE_NAME,
  type ResourceGraph,
} from "./registry.js";
import {
  idString,
  type Connection,
  type ModelDef,
  type Resource,
  type ResourceId,
  type ResourceOrigin,
  type SubagentPolicy,
} from "./types.js";

/** Raised when `/profile <name>` or `spawn_subagent` names an unknown profile. */
export class UnknownProfileError extends Error {
  constructor(readonly profileName: string, known: readonly string[]) {
    super(
      known.length === 0
        ? `Unknown profile "${profileName}". No profiles are defined.`
        : `Unknown profile "${profileName}". Available: ${known.join(", ")}.`,
    );
  }
}

/**
 * Raised when a profile resolves to no usable model, which the agent loop
 * cannot run against (profiles spec §3.11).
 *
 * At startup this is reported by the entry point, which can also try model
 * auto-discovery first; on a `/profile` switch it aborts the switch and leaves
 * the session on the profile it was already using.
 */
export class ProfileHasNoModelError extends Error {
  constructor(readonly profileName: string) {
    super(
      `Profile "${profileName}" has no model. Connect a Model resource to it ` +
        `in ./.vise/index.ts, or start a llama.cpp server so the default ` +
        `model can be auto-discovered.`,
    );
  }
}

/**
 * Everything a session needs to run under one profile (profiles spec §3.5).
 * Produced purely from a `ResourceGraph` plus a profile name — no I/O, no
 * side effects — so switching profiles is just re-resolving.
 */
export interface ResolvedProfile {
  /** The profile's name; `""` for the implicit default. */
  name: string;
  /** The resolved runtime + model configuration for the agent loop. */
  config: Config;
  /**
   * The Model resource this profile resolved to. Startup writes the
   * auto-discovered model name back onto it when `config.model` is null
   * (spec §3.10).
   */
  modelId: ResourceId;
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
 * Resolve a profile into the active configuration (profiles spec §3.5).
 *
 * Traversal follows only the profile's *outgoing* edges, with a visited set so
 * a cyclic config cannot loop forever (spec §8, the DAG assumption).
 *
 * @throws UnknownProfileError when `name` names no profile in the graph.
 */
export function resolveProfile(
  graph: ResourceGraph,
  name: string,
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

  const modelId = modelEdge?.to ?? DEFAULT_MODEL_ID;
  const model = modelDefOf(graph, modelId);
  const systemPrompt =
    profile.def.systemPrompt === "" ? null : profile.def.systemPrompt;

  return {
    name,
    modelId,
    config: {
      ...graph.runtime,
      baseUrl: model.baseUrl,
      model: model.name === "" ? null : model.name,
      apiKey: model.apiKey,
      // Connection props override the model's own parameters (spec §3.5),
      // which in turn override the built-in defaults.
      temperature:
        numberProp(modelEdge, "temperature") ??
        model.temperature ??
        DEFAULT_CONFIG.temperature,
      maxContext:
        numberProp(modelEdge, "maxContext") ??
        model.maxContext ??
        DEFAULT_CONFIG.maxContext,
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

/**
 * The `ModelDef` behind a resource id. The fallback covers a graph whose
 * default model node was somehow removed; an empty `name` resolves to
 * `config.model === null`, which the caller reports as "no model".
 */
function modelDefOf(graph: ResourceGraph, id: ResourceId): ModelDef {
  const resource = graph.resources.get(id);
  if (resource?.kind === "model") return resource.def;
  return { name: "", baseUrl: DEFAULT_BASE_URL, apiKey: "" };
}

/** Read a numeric override off a connection's props, if it has one. */
function numberProp(
  edge: Connection | null,
  key: string,
): number | undefined {
  const value = edge?.props?.[key];
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}
