import type { Tool } from "../types.js";

/**
 * The options a `spawn_subagent` call hands to the runner. The runner is
 * implemented in the application layer (`agent/subagent.ts`); the tool layer
 * only knows this contract, keeping the dependency direction `agent → tools`.
 */
export interface SubagentRunOptions {
  /** The subtask description / instructions. */
  task: string;
  /** Tailored system prompt; a default is used when omitted. */
  systemPrompt?: string;
  /** The subagent's iteration budget (already capped by config). */
  maxIterations: number;
  /** The nesting depth of the subagent to create (parent depth + 1). */
  depth: number;
}

/**
 * Runs a subagent on `task` and returns **only its final `finish` answer** (or
 * a cap/failure note) as a string (spec §3.8.5). Never throws: subagent
 * failures are *data*, not *control* (E18–E20).
 */
export type SubagentRunner = (opts: SubagentRunOptions) => Promise<string>;

/**
 * spawn_subagent (spec §3.3 #9, §3.8).
 *
 * Spawns a fresh, isolated subagent on `task` and returns only its final
 * `finish` answer as the result string. The actual nested agent loop is
 * performed by the injected `runner` (application layer); this tool only
 * validates the call, enforces the depth bound (E20), caps the iteration
 * budget (§3.8.4), and delegates.
 *
 * `mutating` is `false` so that several `spawn_subagent` calls in one assistant
 * message run concurrently (spec §3.8.3) — a deliberate exception to the
 * sequential-mutating rule, since subagents are independent.
 */
export function makeSpawnSubagentTool(
  runner: SubagentRunner,
  depth: number,
  maxSubagentDepth: number,
  subagentMaxIterations: number,
): Tool {
  return {
    name: "spawn_subagent",
    mutating: false,
    description:
      "Spawn a short-lived, isolated subagent to complete a subtask. It runs " +
      "the same tools in its own context and returns only its final answer. " +
      "Use it to offload a self-contained subtask (e.g. research, a focused " +
      "edit, running tests) so its many tool calls stay out of your context. " +
      "Several calls in one message run concurrently.",
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
            "Optional tailored system prompt for this subagent (a default worker prompt is used when omitted).",
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

      // E20: a subagent at depth `depth` may spawn only if depth < maxSubagentDepth.
      if (depth >= maxSubagentDepth) {
        return (
          `Error: max subagent depth reached (${maxSubagentDepth}); ` +
          `cannot spawn a subagent at depth ${depth + 1}.`
        );
      }

      // §3.8.4: effective cap = min(requested, config ceiling), at least 1.
      const maxIterations = Math.max(
        1,
        Math.min(Math.floor(requested), subagentMaxIterations),
      );

      return runner({ task, systemPrompt, maxIterations, depth: depth + 1 });
    },
  };
}
