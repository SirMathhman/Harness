/**
 * User-facing hook types (hooks spec §3.2).
 *
 * A hook is created with `reg.createHook()` in `.vise/index.ts` and connected
 * to the profiles it applies to. These types are re-exported from the package
 * root so a config module can write `import type { Hook } from "vise"`.
 */

/** The lifecycle points at which hooks fire (hooks spec §3.1; KV spec §3.3). */
export type HookEvent =
  | "tool:before"
  | "tool:after"
  | "turn:start"
  | "turn:end"
  | "session:start"
  | "session:end"
  | "on:compaction"
  | "subagent:before"
  | "subagent:after"
  | "subagent:turn:start"
  | "subagent:turn:end";

/** Every valid `HookEvent`, in spec order. Used for validation and messages. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "tool:before",
  "tool:after",
  "turn:start",
  "turn:end",
  "session:start",
  "session:end",
  "on:compaction",
  "subagent:before",
  "subagent:after",
  "subagent:turn:start",
  "subagent:turn:end",
];

/**
 * The events whose handlers may return a Promise, which the dispatcher awaits
 * (KV spec §3.3, §8.1; v0.6.0 spec §2.3). Every other event stays
 * synchronous-only: a Promise returned there is an unsupported result, exactly
 * as before.
 */
export const ASYNC_HOOK_EVENTS: readonly HookEvent[] = [
  "subagent:before",
  "subagent:after",
  "subagent:turn:start",
  "subagent:turn:end",
];

/**
 * The subagent-side events that only ever fire at subagent depth (≥ 1), on the
 * subagent's own hook manager (v0.6.0 spec §2.2, §3.3, §3.4). A hook that
 * listens to one of these must set `includeSubagents: true`, or the config is
 * rejected at startup (v0.6.0 spec §3.6).
 */
export const SUBAGENT_SIDE_EVENTS: readonly HookEvent[] = [
  "subagent:turn:start",
  "subagent:turn:end",
];

/** Whether `event` is a subagent-side event requiring `includeSubagents`. */
export function isSubagentSideEvent(event: HookEvent): boolean {
  return SUBAGENT_SIDE_EVENTS.includes(event);
}

/**
 * The terminal outcome of a subagent run, reported on `subagent:turn:end`
 * (v0.6.0 spec §2.4, §3.4).
 */
export type SubagentOutcome = "done" | "cap" | "failed";

/** Whether `event` is one of the two events that permit an async handler. */
export function isAsyncHookEvent(event: HookEvent): boolean {
  return ASYNC_HOOK_EVENTS.includes(event);
}

/**
 * The events on which a block is *effective*. A block returned on any other
 * event is downgraded to an advisory message (hooks spec §3.1).
 */
export const BLOCKING_HOOK_EVENTS: readonly HookEvent[] = [
  "tool:before",
  "turn:end",
];

/** Type guard for a raw value being a valid `HookEvent` literal. */
export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && HOOK_EVENTS.includes(value as HookEvent);
}

/** Whether a block returned on `event` actually blocks (hooks spec §3.1). */
export function canBlock(event: HookEvent): boolean {
  return BLOCKING_HOOK_EVENTS.includes(event);
}

/** The data a hook handler receives when its event fires. */
export interface HookContext {
  /** The event that fired. */
  event: HookEvent;
  /** Present for `tool:before` and `tool:after` only. */
  tool?: {
    name: string;
    args: Record<string, unknown>;
    /** Present for `tool:after` only. The tool's result string. */
    result?: string;
  };
  /** The working directory (project root) the agent is operating in. */
  cwd: string;
  /** Subagent depth. 0 = parent session. */
  depth: number;
  /**
   * The active model name of the agent whose event this is. Present for
   * `subagent:before` / `subagent:after` (the spawner's model, KV spec §3.6);
   * a provider's KV save/restore sends it to a llama.cpp router, which needs
   * it to know which model's slot to act on. Also present on
   * `subagent:turn:start` / `subagent:turn:end` (the subagent's own model).
   */
  model?: string;
  /**
   * The terminal outcome of the subagent run (v0.6.0 spec §2.4, §3.4). Present
   * only on `subagent:turn:end`; absent on every other event.
   */
  outcome?: SubagentOutcome;
}

/**
 * What a handler returns (hooks spec §3.2):
 * - `void` — allow, no message.
 * - `string` — block, with the string as the reason.
 * - `{ message, block? }` — block when `block === true`, else advisory.
 */
export type HookResult = void | string | { message: string; block?: boolean };

/**
 * A hook handler. Synchronous for every event except the four subagent events
 * (`subagent:before`, `subagent:after`, `subagent:turn:start`,
 * `subagent:turn:end`), whose handlers may return a Promise that the
 * dispatcher awaits (hooks spec §8; KV spec §8.1; v0.6.0 spec §2.3). A Promise
 * returned on any other event is an unsupported result: it is warned about and
 * ignored.
 */
export type HookHandler = (
  ctx: HookContext,
) => HookResult | Promise<HookResult>;

/** A user-defined lifecycle handler. */
export interface Hook {
  /** One or more events this hook subscribes to. */
  events: HookEvent[];
  /** The handler invoked when any subscribed event fires. */
  handler: HookHandler;
  /** If true, the hook also fires in subagent contexts. Default: false. */
  includeSubagents?: boolean;
}
