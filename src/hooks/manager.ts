import { canBlock, type Hook, type HookContext, type HookEvent } from "./types.js";

/** A loaded hook plus where it came from (shown by `/hooks`). */
export interface RegisteredHook {
  hook: Hook;
  /**
   * Where this hook came from: a hook file path, or the resource id of the
   * hook node in the `.vise` graph.
   */
  source: string;
  /**
   * Tool names this hook is restricted to, from its Hook→Tool edges
   * (profiles spec §3.7). Omitted or empty means the hook fires for every
   * tool. Only `tool:before` / `tool:after` are affected; the hook still
   * fires normally for session- and turn-level events.
   */
  tools?: string[];
}

/**
 * The collected effect of one dispatch (hooks spec §3.5).
 *
 * `block` is the `"; "`-joined reason when the event was blocked (only ever
 * non-null for `tool:before` and `turn:end`); `advisory` is the `"\n"`-joined
 * message to inject as a system message. Both may be set at once for a mixed
 * result.
 */
export interface HookOutcome {
  block: string | null;
  advisory: string | null;
}

/** The outcome of a dispatch that produced nothing. Shared, never mutated. */
const NO_OUTCOME: HookOutcome = Object.freeze({ block: null, advisory: null });

/** Per-dispatch inputs that vary by call site. */
export interface HookDispatchOptions {
  /** Subagent depth; 0 (the parent session) when omitted. */
  depth?: number;
  /** Tool data, for `tool:before` / `tool:after`. */
  tool?: {
    name: string;
    args: Record<string, unknown>;
    result?: string;
  };
}

export interface HookManagerOptions {
  /** The `cwd` handed to every `HookContext`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Where hook errors and warnings go. Defaults to stderr. */
  log?: (message: string) => void;
}

/**
 * The runtime that stores hooks and dispatches lifecycle events to them
 * (hooks spec §3.4). A pure dispatcher: given hooks + a context it produces a
 * `HookOutcome`; applying that outcome is the caller's job.
 *
 * Scoped to a session — there is no module-level mutable state.
 */
export class HookManager {
  private readonly registered: RegisteredHook[];
  private readonly cwd: string;
  private readonly log: (message: string) => void;
  private enabled = true;

  constructor(hooks: RegisteredHook[] = [], options: HookManagerOptions = {}) {
    this.registered = [...hooks];
    this.cwd = options.cwd ?? process.cwd();
    this.log =
      options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /**
   * True when a dispatch could actually reach a handler. Call sites on the hot
   * path (per tool call) check this first so an unconfigured session pays
   * nothing at all (hooks spec §5).
   */
  get active(): boolean {
    return this.enabled && this.registered.length > 0;
  }

  /** How many hooks are registered (independent of enabled/disabled). */
  get size(): number {
    return this.registered.length;
  }

  /** Whether hooks are currently enabled (`/hooks on|off`). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable or disable every hook for the rest of the session. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** The registered hooks in registration order (for the `/hooks` listing). */
  list(): readonly RegisteredHook[] {
    return this.registered;
  }

  /**
   * Fire `event` and collect the results of every matching hook
   * (hooks spec §3.4).
   *
   * Hooks run sequentially in registration order with no short-circuit: a hook
   * that blocks, or throws, does not stop the ones after it.
   */
  dispatch(event: HookEvent, options: HookDispatchOptions = {}): HookOutcome {
    if (!this.active) return NO_OUTCOME;

    const depth = options.depth ?? 0;
    const matching = this.registered.filter(
      (entry) =>
        entry.hook.events.includes(event) &&
        (depth === 0 || entry.hook.includeSubagents === true) &&
        matchesToolFilter(entry, options.tool?.name),
    );
    if (matching.length === 0) return NO_OUTCOME;

    const ctx: HookContext = {
      event,
      cwd: this.cwd,
      depth,
      ...(options.tool ? { tool: options.tool } : {}),
    };
    const blocking = canBlock(event);
    const blocks: string[] = [];
    const advisories: string[] = [];

    for (const { hook, source } of matching) {
      let result: unknown;
      try {
        result = hook.handler(ctx);
      } catch (err) {
        // §3.6: a throw is a block (an advisory on non-blocking events), is
        // logged with its source file, and does not stop the other hooks.
        const message = errorMessage(err);
        this.log(`[hook error] ${source} (${event}): ${message}`);
        (blocking ? blocks : advisories).push(message);
        continue;
      }
      this.collect(result, { blocking, blocks, advisories, source, event });
    }

    return {
      block: blocks.length > 0 ? blocks.join("; ") : null,
      advisory: advisories.length > 0 ? advisories.join("\n") : null,
    };
  }

  /** Sort one handler's return value into the block/advisory buckets (§3.2). */
  private collect(
    result: unknown,
    sink: {
      blocking: boolean;
      blocks: string[];
      advisories: string[];
      source: string;
      event: HookEvent;
    },
  ): void {
    // void / undefined / null -> allow, no message.
    if (result === undefined || result === null) return;

    // string -> block (downgraded to advisory on non-blocking events).
    if (typeof result === "string") {
      (sink.blocking ? sink.blocks : sink.advisories).push(result);
      return;
    }

    if (typeof result === "object") {
      const { message, block } = result as {
        message?: unknown;
        block?: unknown;
      };
      if (typeof message === "string") {
        if (block === true) {
          (sink.blocking ? sink.blocks : sink.advisories).push(message);
        } else {
          sink.advisories.push(message);
        }
        return;
      }
    }

    // Anything else (a number, an object without `message`, …) is ignored.
    this.log(
      `[hook warning] ${sink.source} (${sink.event}) returned an unsupported ` +
        `value (${typeof result}); treating it as no result.`,
    );
  }
}

/**
 * Whether a hook's Hook→Tool edges let it fire for this dispatch
 * (profiles spec §3.7).
 *
 * A hook with no edges always fires. One with edges fires only for the tools
 * it is connected to — and, for events that carry no tool at all (`turn:end`,
 * `session:start`, …), the filter is irrelevant, so the hook fires normally.
 */
function matchesToolFilter(
  entry: RegisteredHook,
  toolName: string | undefined,
): boolean {
  if (entry.tools === undefined || entry.tools.length === 0) return true;
  if (toolName === undefined) return true;
  return entry.tools.includes(toolName);
}

/** The message of a thrown value, whatever was thrown. */
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
