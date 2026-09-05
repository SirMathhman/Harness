import type { Tool } from "../types.js";
import type { SubagentPolicy } from "../profiles/types.js";

/** The parent agent's active model, for subagent inheritance (providers spec §3.7). */
export interface ParentModel {
  baseUrl: string;
  model: string | null;
  apiKey: string;
  temperature: number;
  maxContext: number;
}

/**
 * The options a `spawn_subagent` call hands to the runner. The runner is
 * implemented in the application layer (`agent/subagent.ts`); the tool layer
 * only knows this contract, keeping the dependency direction `agent → tools`.
 */
export interface SubagentRunOptions {
  /** The subtask description / instructions. */
  task: string;
  /** Tailored system prompt; the profile's own prompt is used when omitted. */
  systemPrompt?: string;
  /** The subagent's iteration budget (already capped by config). */
  maxIterations: number;
  /** The nesting depth of the subagent to create (parent depth + 1). */
  depth: number;
  /** The profile the subagent runs under (profiles spec §3.12). */
  profile: string;
  /**
   * The parent's active model (providers spec §3.7): inherited by the
   * subagent when its profile declares no `models` whitelist, or falls back
   * to it when the whitelist matches nothing (E-P8).
   */
  parentModel: ParentModel;
}

/**
 * Runs a subagent on `task` and returns **only its final `finish` answer** (or
 * a cap/failure note) as a string (spec §3.8.5). Never throws: subagent
 * failures are *data*, not *control* (E18–E20).
 */
export type SubagentRunner = (opts: SubagentRunOptions) => Promise<string>;

/** Everything the tool needs to validate and delegate a spawn. */
export interface SpawnSubagentOptions {
  /** Runs the nested agent loop. */
  runner: SubagentRunner;
  /** The nesting depth of the agent that owns this tool (0 for the main one). */
  depth: number;
  /** The profile the owning agent runs under; the default for the subagent. */
  parentProfile: string;
  /** The owning profile's subagent policy, if it declared one (§3.12). */
  policy?: SubagentPolicy;
  /** Global depth backstop, used when the policy sets no `maxDepth`. */
  fallbackMaxDepth: number;
  /** Ceiling on the subagent's iteration budget (§3.8.4). */
  subagentMaxIterations: number;
  /** Every profile name a subagent could name. Empty when none are defined. */
  knownProfiles: readonly string[];
  /** The owning agent's active model, passed through for subagent inheritance. */
  parentModel: ParentModel;
}

/**
 * spawn_subagent (spec §3.3 #9, §3.8; profiles spec §3.12).
 *
 * Spawns a fresh, isolated subagent on `task` and returns only its final
 * `finish` answer as the result string. The actual nested agent loop is
 * performed by the injected `runner` (application layer); this tool only
 * validates the call, enforces the profile allow-list and the depth bound,
 * caps the iteration budget, and delegates.
 *
 * `mutating` is `false` so that several `spawn_subagent` calls in one assistant
 * message run concurrently (spec §3.8.3) — a deliberate exception to the
 * sequential-mutating rule, since subagents are independent.
 */
export function makeSpawnSubagentTool(options: SpawnSubagentOptions): Tool {
  const {
    runner,
    depth,
    parentProfile,
    policy,
    fallbackMaxDepth,
    subagentMaxIterations,
    knownProfiles,
    parentModel,
  } = options;

  // A policy's own maxDepth wins; otherwise the global backstop applies
  // ("same as current behavior", profiles spec §3.12.3).
  const maxDepth = policy?.maxDepth ?? fallbackMaxDepth;
  const allowed = policy?.profiles;

  return {
    name: "spawn_subagent",
    mutating: false,
    description:
      "Spawn a short-lived, isolated subagent to complete a subtask. It runs " +
      "in its own context and returns only its final answer. Use it to " +
      "offload a self-contained subtask (e.g. research, a focused edit, " +
      "running tests) so its many tool calls stay out of your context. " +
      "Several calls in one message run concurrently." +
      profileHint(allowed, knownProfiles),
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A clear, self-contained description of the subtask for the subagent.",
        },
        maxIterations: {
          type: "integer",
          description:
            "The subagent's iteration budget (capped by the configured ceiling).",
        },
        systemPrompt: {
          type: "string",
          description:
            "Optional tailored system prompt for this subagent (its profile's prompt is used when omitted).",
        },
        profile: {
          type: "string",
          description:
            "Optional profile the subagent runs under, giving it that profile's prompt, tools, hooks, and model. Defaults to the current profile.",
        },
      },
      required: ["task", "maxIterations"],
    },
    async handler(args) {
      const task = String(args.task ?? "");
      const requested =
        typeof args.maxIterations === "number" ? args.maxIterations : 0;
      const systemPrompt =
        typeof args.systemPrompt === "string" && args.systemPrompt.length > 0
          ? args.systemPrompt
          : undefined;

      // §3.12.1: no `profile` param → the subagent inherits the parent's.
      const requestedProfile =
        typeof args.profile === "string" && args.profile.length > 0
          ? args.profile
          : null;

      if (requestedProfile !== null) {
        // §3.12.2: the name must be one the parent's policy permits…
        if (allowed !== undefined && !allowed.includes(requestedProfile)) {
          return (
            `Error: Profile '${requestedProfile}' is not allowed for ` +
            `subagents. Allowed: [${allowed.join(", ")}]`
          );
        }
        // …and it must actually exist.
        if (!knownProfiles.includes(requestedProfile)) {
          return (
            `Error: Unknown profile '${requestedProfile}'. ` +
            (knownProfiles.length > 0
              ? `Available: [${knownProfiles.join(", ")}]`
              : "No profiles are defined.")
          );
        }
      }

      // §3.12.3: a spawn is rejected when it would exceed the depth limit.
      if (depth + 1 > maxDepth) {
        return `Error: Subagent depth limit reached (max: ${maxDepth})`;
      }

      // §3.8.4: effective cap = min(requested, config ceiling), at least 1.
      const maxIterations = Math.max(
        1,
        Math.min(Math.floor(requested), subagentMaxIterations),
      );

      return runner({
        task,
        systemPrompt,
        maxIterations,
        depth: depth + 1,
        profile: requestedProfile ?? parentProfile,
        parentModel,
      });
    },
  };
}

/** Tell the model which profiles it may actually name, when that is bounded. */
function profileHint(
  allowed: string[] | undefined,
  known: readonly string[],
): string {
  if (allowed !== undefined) {
    return allowed.length === 0
      ? " No profiles may be named for subagents."
      : ` Allowed profiles: ${allowed.join(", ")}.`;
  }
  return known.length > 0 ? ` Available profiles: ${known.join(", ")}.` : "";
}
