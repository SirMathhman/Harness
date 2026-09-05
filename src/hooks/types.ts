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
  | "subagent:after";

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
];

/**
 * The two events whose handlers may return a Promise, which the dispatcher
 * awaits (KV spec §3.3, §8.1). Every other event stays synchronous-only: a
 * Promise returned there is an unsupported result, exactly as before.
 */
export const ASYNC_HOOK_EVENTS: readonly HookEvent[] = [
  "subagent:before",
  "subagent:after",
];

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
  return (
    typeof value === "string" && HOOK_EVENTS.includes(value as HookEvent)
  );
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
}

/**
 * What a handler returns (hooks spec §3.2):
 * - `void` — allow, no message.
 * - `string` — block, with the string as the reason.
 * - `{ message, block? }` — block when `block === true`, else advisory.
 */
export type HookResult =
  | void
  | string
  | { message: string; block?: boolean };

/**
 * A hook handler. Synchronous for every event except `subagent:before` and
 * `subagent:after`, whose handlers may return a Promise that the dispatcher
 * awaits (hooks spec §8; KV spec §8.1). A Promise returned on any other event
 * is an unsupported result: it is warned about and ignored.
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
