import { BUILTIN_TOOL_NAMES, FINISH_TOOL_NAME } from "../tools/names.js";
import {
  HOOK_EVENTS,
  isHookEvent,
  isSubagentSideEvent,
} from "../hooks/types.js";
import { RUNTIME_KEYS } from "../config/defaults.js";
import { IMPLICIT_PROFILE_NAME, type ResourceGraph } from "./registry.js";
import { availableModelIds } from "./resolve.js";
import {
  idString,
  type ModelSelection,
  type Resource,
  type ResourceKind,
  type ResourceOrigin,
} from "./types.js";

/**
 * A `.vise/index.ts` that cannot be used. Always fatal: Vise exits rather than
 * running under half a configuration (profiles spec §3.10, §4).
 */
export class ViseConfigError extends Error {}

/**
 * The connection types the graph allows (profiles spec §3.4). Anything else —
 * Tool→Profile, Model→Hook, Profile→Profile — is a fatal config error.
 */
const VALID_EDGES: ReadonlySet<string> = new Set([
  "profile->hook",
  "profile->tool",
  "profile->model",
  "hook->tool",
]);

/**
 * Validate a finished graph (profiles spec §3.11).
 *
 * Every problem found is reported at once, so a user fixing their config sees
 * the whole list rather than one error per run.
 *
 * @throws ViseConfigError listing every problem.
 */
export function validateGraph(graph: ResourceGraph): ResourceGraph {
  const problems: string[] = [];

  validateResources(graph, problems);
  validateConnections(graph, problems);
  validateProfileToolSets(graph, problems);
  validateSubagentPolicies(graph, problems);
  validateModelWhitelists(graph, problems);
  validateRuntime(graph, problems);

  if (problems.length > 0) {
    throw new ViseConfigError(
      `Invalid .vise configuration:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return graph;
}

/**
 * Record a name against its kind's seen-names map (config spec §3.3) and push
 * whichever conflict message fits: a cross-file collision (one "global", one
 * "project") gets the spec's fixed "Config conflict" wording; anything else
 * (a duplicate within one file, or a custom resource shadowing a built-in)
 * gets the older, more specific message.
 */
function recordNameConflict(
  problems: string[],
  kind: "profile" | "tool" | "model",
  name: string,
  origin: ResourceOrigin,
  seen: Map<string, ResourceOrigin>,
): void {
  const prior = seen.get(name);
  if (prior === undefined) {
    seen.set(name, origin);
    return;
  }
  const crossFile =
    (prior === "global" && origin === "project") ||
    (prior === "project" && origin === "global");
  if (crossFile) {
    problems.push(
      `Config conflict: a ${kind} named "${name}" is defined in both the ` +
        `global config (~/.vise/index.ts) and the project config ` +
        `(./.vise/index.ts). Remove one or rename it.`,
    );
    return;
  }
  if (kind === "tool" && prior === "builtin") {
    problems.push(
      `Duplicate tool name "${name}" (a built-in or another custom tool ` +
        `already uses it).`,
    );
    return;
  }
  problems.push(`Duplicate ${kind} name "${name}".`);
}

/** Profile names and tool names must each be unique and well-formed. */
function validateResources(graph: ResourceGraph, problems: string[]): void {
  const profileNames = new Map<string, ResourceOrigin>();
  const toolNames = new Map<string, ResourceOrigin>(
    BUILTIN_TOOL_NAMES.map((name) => [name, "builtin" as ResourceOrigin]),
  );
  const modelNames = new Map<string, ResourceOrigin>();

  for (const resource of graph.resources.values()) {
    switch (resource.kind) {
      case "profile": {
        if (resource.implicit) break;
        const { name } = resource.def;
        if (typeof name !== "string" || name.trim() === "") {
          problems.push(
            `Profile ${idString(resource.id)} must have a non-empty name.`,
          );
          break;
        }
        if (name === IMPLICIT_PROFILE_NAME) {
          problems.push(
            `Profile name "${IMPLICIT_PROFILE_NAME}" is reserved for the ` +
              `implicit built-in profile. Choose a different name.`,
          );
          break;
        }
        recordNameConflict(
          problems,
          "profile",
          name,
          resource.origin,
          profileNames,
        );
        if (typeof resource.def.systemPrompt !== "string") {
          problems.push(
            `Profile "${name}" must have a string systemPrompt ` +
              `(use "" for the built-in default).`,
          );
        }
        break;
      }
      case "tool": {
        if (resource.def === null) break; // built-in placeholder
        const { name } = resource;
        if (typeof name !== "string" || name === "") {
          problems.push(
            `Tool ${idString(resource.id)} must have a non-empty name.`,
          );
          break;
        }
        recordNameConflict(problems, "tool", name, resource.origin, toolNames);
        if (typeof resource.def.handler !== "function") {
          problems.push(`Tool "${name}" must have a handler function.`);
        }
        break;
      }
      case "hook": {
        const { events, handler, includeSubagents } = resource.def;
        if (!Array.isArray(events) || events.length === 0) {
          problems.push(
            `Hook ${idString(resource.id)} must have a non-empty "events" ` +
              `array. Valid events: ${HOOK_EVENTS.join(", ")}.`,
          );
        } else {
          for (const event of events) {
            if (!isHookEvent(event)) {
              problems.push(
                `Hook ${idString(resource.id)} has an invalid event ` +
                  `${JSON.stringify(event)}. Valid events: ` +
                  `${HOOK_EVENTS.join(", ")}.`,
              );
            }
          }
        }
        if (typeof handler !== "function") {
          problems.push(
            `Hook ${idString(resource.id)} must have a handler function.`,
          );
        }
        // v0.6.0 spec §3.6: a subagent-side event only ever fires at subagent
        // depth (≥ 1), so a hook that listens to one without
        // `includeSubagents: true` could never fire — a config bug, not a valid
        // configuration.
        if (Array.isArray(events)) {
          for (const event of events) {
            if (isSubagentSideEvent(event) && includeSubagents !== true) {
              problems.push(
                `Config error: hook ${idString(resource.id)} listens to ` +
                  `${event} but does not set includeSubagents: true. This ` +
                  `event only fires at subagent depth; the hook would never ` +
                  `fire.`,
              );
            }
          }
        }
        break;
      }
      case "model": {
        if (resource.discovered) break;
        const { name, baseUrl } = resource.def;
        // An empty name is legal (a model the config never intends to address
        // by name); empty names are never checked for conflicts.
        if (typeof name !== "string") {
          problems.push(
            `Model ${idString(resource.id)} must have a string name (use "" ` +
              `to auto-discover it from the server).`,
          );
        } else if (name !== "") {
          recordNameConflict(
            problems,
            "model",
            name,
            resource.origin,
            modelNames,
          );
        }
        if (typeof baseUrl !== "string" || baseUrl === "") {
          problems.push(
            `Model ${idString(resource.id)} must have a non-empty baseUrl.`,
          );
        }
        break;
      }
    }
  }
}

/** Both endpoints must exist, and the kind pair must be one of the four. */
function validateConnections(graph: ResourceGraph, problems: string[]): void {
  for (const edge of graph.connections) {
    const from = graph.resources.get(edge.from);
    const to = graph.resources.get(edge.to);
    if (from === undefined || to === undefined) {
      problems.push(
        `Connection ${idString(edge.from)} → ${idString(edge.to)} references ` +
          `a resource that does not exist.`,
      );
      continue;
    }
    if (!VALID_EDGES.has(`${from.kind}->${to.kind}`)) {
      problems.push(
        `Invalid connection ${describe(from)} → ${describe(to)}. Valid ` +
          `connections are Profile→Hook, Profile→Tool, Profile→Model, and ` +
          `Hook→Tool.`,
      );
    }
  }
}

/**
 * A profile that enumerates its tools must include `finish`.
 *
 * The agent loop ends a turn when the model calls `finish`; a profile that
 * advertises a tool set without it could only ever end a turn by running out
 * of iterations, so the config is rejected rather than left to deadlock at
 * runtime.
 */
function validateProfileToolSets(
  graph: ResourceGraph,
  problems: string[],
): void {
  for (const resource of graph.resources.values()) {
    if (resource.kind !== "profile") continue;
    const tools: string[] = [];
    for (const edge of graph.edgesFrom.get(resource.id) ?? []) {
      const target = graph.resources.get(edge.to);
      if (target?.kind === "tool") tools.push(target.name);
    }
    if (tools.length > 0 && !tools.includes(FINISH_TOOL_NAME)) {
      problems.push(
        `Profile "${resource.def.name}" enumerates its tools but omits ` +
          `"${FINISH_TOOL_NAME}", which the agent needs to end a turn. Add ` +
          `reg.createConnection(profile, reg.builtins.tools.finish).`,
      );
    }
  }
}

/** `subagent.profiles` must name profiles that exist; `maxDepth` must be sane. */
function validateSubagentPolicies(
  graph: ResourceGraph,
  problems: string[],
): void {
  for (const resource of graph.resources.values()) {
    if (resource.kind !== "profile") continue;
    const policy = resource.def.subagent;
    if (policy === undefined) continue;
    const where = resource.implicit
      ? "the default profile"
      : `profile "${resource.def.name}"`;

    if (policy.profiles !== undefined) {
      if (!Array.isArray(policy.profiles)) {
        problems.push(`subagent.profiles on ${where} must be an array.`);
      } else {
        for (const name of policy.profiles) {
          if (!graph.profiles.has(name)) {
            problems.push(
              `subagent.profiles on ${where} names an unknown profile ` +
                `"${name}".`,
            );
          }
        }
      }
    }

    if (
      policy.maxDepth !== undefined &&
      (typeof policy.maxDepth !== "number" ||
        !Number.isInteger(policy.maxDepth) ||
        policy.maxDepth < 0)
    ) {
      problems.push(
        `subagent.maxDepth on ${where} must be a non-negative integer.`,
      );
    }
  }
}

/**
 * A profile's `models` whitelist (providers spec §3.4, §3.11):
 * - every provider name it references must be registered (E-P3);
 * - a `Profile → Model` connection, if any, must target a model within the
 *   whitelist's available set (E-P5). This is checkable here (rather than
 *   deferred to startup) because a connection can only ever target a model
 *   that already exists when the config runs — i.e. one declared via
 *   `reg.createModel()`, which never carries a `provider` field and is
 *   therefore either matched by every profile (no whitelist) or by none
 *   (any non-empty whitelist, since whitelist elements are provider
 *   references).
 */
function validateModelWhitelists(
  graph: ResourceGraph,
  problems: string[],
): void {
  for (const resource of graph.resources.values()) {
    if (resource.kind !== "profile") continue;
    const selection = resource.def.models;
    if (selection === undefined) continue;
    const where = resource.implicit
      ? "the default profile"
      : `Profile "${resource.def.name}"`;

    if (!Array.isArray(selection)) {
      problems.push(`${where} has a "models" whitelist that must be an array.`);
      continue;
    }

    for (const element of selection) {
      const providerName = typeof element === "string" ? element : element?.[0];
      if (
        typeof providerName !== "string" ||
        !graph.providerNames.has(providerName)
      ) {
        const known = [...graph.providerNames.keys()];
        problems.push(
          `${where} references unknown provider ${JSON.stringify(providerName)} ` +
            `in its models whitelist. Registered providers: ` +
            `${known.length > 0 ? known.join(", ") : "(none)"}.`,
        );
      }
    }

    if (selection.length === 0) continue;

    const connectedModel = firstModelEdgeTarget(graph, resource.id);
    if (connectedModel === null) continue;

    const available = availableModelIds(graph, selection as ModelSelection);
    if (!available.includes(connectedModel.id)) {
      problems.push(
        `${where} is connected to model "${connectedModel.name}" which is ` +
          `not in its models whitelist.`,
      );
    }
  }
}

/** The first Profile→Model connection's target, if any, name included. */
function firstModelEdgeTarget(
  graph: ResourceGraph,
  profileId: Resource["id"],
): { id: Resource["id"]; name: string } | null {
  for (const edge of graph.edgesFrom.get(profileId) ?? []) {
    const target = graph.resources.get(edge.to);
    if (target?.kind === "model")
      return { id: target.id, name: target.def.name };
  }
  return null;
}

/** Range-check the values a config passed to `reg.setRuntime()`. */
function validateRuntime(graph: ResourceGraph, problems: string[]): void {
  const r = graph.runtime;
  const positive = [
    "commandTimeoutMs",
    "maxToolOutputChars",
    "subagentMaxIterations",
  ] as const;
  for (const key of positive) {
    const value = r[key];
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
      problems.push(`setRuntime: ${key} must be a positive number.`);
    }
  }
  if (
    typeof r.compactThreshold !== "number" ||
    r.compactThreshold <= 0 ||
    r.compactThreshold > 1
  ) {
    problems.push("setRuntime: compactThreshold must be in (0, 1].");
  }
  if (typeof r.compactKeepMessages !== "number" || r.compactKeepMessages < 0) {
    problems.push("setRuntime: compactKeepMessages must be >= 0.");
  }
  if (typeof r.maxSubagentDepth !== "number" || r.maxSubagentDepth < 0) {
    problems.push("setRuntime: maxSubagentDepth must be >= 0.");
  }
  if (
    r.maxIterations !== null &&
    (typeof r.maxIterations !== "number" || r.maxIterations < 1)
  ) {
    problems.push(
      "setRuntime: maxIterations must be a positive integer or null.",
    );
  }
  if (typeof r.parallelToolCalls !== "boolean") {
    problems.push("setRuntime: parallelToolCalls must be a boolean.");
  }
  if (typeof r.dynamicTools !== "boolean") {
    problems.push("setRuntime: dynamicTools must be a boolean.");
  }
  if (typeof r.shell !== "string") {
    problems.push("setRuntime: shell must be a string.");
  }
  for (const key of Object.keys(r)) {
    if (!RUNTIME_KEYS.includes(key as never)) {
      problems.push(
        `setRuntime: unknown setting "${key}". Valid settings: ` +
          `${RUNTIME_KEYS.join(", ")}.`,
      );
    }
  }
  if (r.profileSwitchMode !== "replace" && r.profileSwitchMode !== "append") {
    problems.push(
      `setRuntime: profileSwitchMode must be "replace" or "append" (got ` +
        `${JSON.stringify(r.profileSwitchMode)}).`,
    );
  }
}

/** A short label for a resource, used in connection error messages. */
function describe(resource: Resource): string {
  const label: Record<ResourceKind, string> = {
    profile: "Profile",
    hook: "Hook",
    tool: "Tool",
    model: "Model",
  };
  const name =
    resource.kind === "tool"
      ? resource.name
      : resource.kind === "profile" || resource.kind === "model"
        ? resource.def.name
        : "";
  return `${label[resource.kind]} "${name || idString(resource.id)}"`;
}
