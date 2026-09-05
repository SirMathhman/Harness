import { createInterface, type Interface } from "node:readline";
import { homedir } from "node:os";
import type { Session } from "../types.js";
import { runTurn, type AgentCallbacks } from "../agent/loop.js";
import { createSession, type SessionHandle } from "../agent/session.js";
import type { SubagentRender } from "../agent/subagent.js";
import { LLMError } from "../llm/errors.js";
import { HookManager } from "../hooks/index.js";
import {
  IMPLICIT_PROFILE_NAME,
  ProfileHasNoModelError,
  UnknownProfileError,
  writeConfigStub,
  writeStateFile,
  type ResourceGraph,
} from "../profiles/index.js";

/**
 * Run the interactive REPL (spec §3.6).
 *
 * - Multi-turn: history is retained across prompts, including across a
 *   `/profile` switch (profiles spec §3.6).
 * - Live output: streamed tokens, one line per tool call + condensed result,
 *   delimited finish answer.
 * - Ctrl-C (E15): aborts the current turn, kills the foreground command, and
 *   returns to the prompt.
 * - `exit` / `quit` end the session.
 *
 * `graph` is the resource graph built from `.vise/index.ts`; omitted → the
 * built-in defaults (profiles spec §3.8). `profile` is the starting profile,
 * already resolved from the state file (config spec §3.7); `statePath` is
 * where that profile and the active model are saved back to on a clean exit
 * (config spec §3.8.3).
 */
export async function startRepl(
  graph: ResourceGraph,
  profile: string,
  statePath: string,
  initialTask?: string | null,
): Promise<void> {
  const handle = createSession({
    graph,
    profile,
    render: makeSubagentRender(),
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const callbacks: AgentCallbacks = {
    onToken: (t) => process.stdout.write(t),
    onToolCall: (name, args) => {
      process.stdout.write(`\n→ ${name}(${summarizeArgs(args)})\n`);
    },
    onToolResult: (name, ok, summary) => {
      process.stdout.write(`${ok ? "✓" : "✗"} ${name}: ${summary}\n`);
    },
    onCompacting: () => process.stdout.write("\n[compacting context…]\n"),
  };

  // Run an initial task if one was passed on the command line.
  if (initialTask) {
    await executeTurn(handle, callbacks, initialTask);
  }

  const ctx: ReplContext = { handle };
  for (;;) {
    if (closed) break;
    const line = await prompt(rl, `${promptLabel(handle)}> `);
    if (closed) break;
    const input = line.trim();
    if (input === "") continue;
    const cmd = findCommand(input);
    if (cmd) {
      // Commands only run between turns, so a `/profile` switch can never take
      // effect mid-turn (profiles spec §4).
      const out = cmd.run(ctx, commandArgs(input));
      if (out !== undefined) process.stdout.write(out + "\n");
      if (cmd.exits) break;
      continue;
    }
    await executeTurn(handle, callbacks, input);
  }

  // session:end (hooks §3.1): a block is ignored, but the message is shown —
  // the session is ending, so there is no conversation left to inject it into.
  const ended = handle.session.hooks.dispatch("session:end", { depth: 0 });
  if (ended.advisory) process.stdout.write(`${ended.advisory}\n`);

  // Profile persistence (config spec §3.8.3): every path out of the loop above
  // is a clean exit (`/exit`, bare `exit`/`quit`, or stdin closing on Ctrl-D),
  // so the active profile and model are saved here unconditionally. Ctrl-C
  // mid-turn never reaches this point — it aborts the turn and returns to the
  // prompt instead (§3.8.3, C13).
  writeStateFile(statePath, handle.profile, handle.session.config.model ?? "");

  handle.manager.killAll();
  rl.close();
}

/**
 * Run a single turn with Ctrl-C handling (E15): aborts the turn and kills the
 * foreground command, then returns to the prompt.
 *
 * The registry and command manager are read off the handle here rather than
 * captured, because a `/profile` switch replaces both.
 */
async function executeTurn(
  handle: SessionHandle,
  callbacks: AgentCallbacks,
  input: string,
): Promise<void> {
  const ac = new AbortController();
  const onSigint = () => {
    ac.abort();
    handle.manager.killAll();
    process.stdout.write("\n[interrupted]\n");
  };
  process.on("SIGINT", onSigint);

  try {
    const result = await runTurn(
      handle.session,
      input,
      handle.registry,
      callbacks,
      ac.signal,
    );
    if (result.finished) {
      process.stdout.write(`\n${result.answer}\n`);
    }
  } catch (err) {
    if (err instanceof LLMError) {
      process.stdout.write(`\n[LLM error] ${err.message}\n`);
    } else if (!ac.signal.aborted) {
      process.stdout.write(`\n[error] ${(err as Error).message}\n`);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * Promise-based readline prompt. Resolves with an empty string if the
 * interface closes before a line is entered (e.g. stdin EOF / Ctrl-D), so the
 * caller can detect the closed state and exit cleanly instead of hanging.
 */
function prompt(rl: Interface, label: string): Promise<string> {
  return new Promise((resolve) => {
    const onClose = () => resolve("");
    rl.once("close", onClose);
    rl.question(label, (answer) => {
      rl.removeListener("close", onClose);
      resolve(answer);
    });
  });
}

/** `vise>`, or `vise:refactor>` when a named profile is active. */
export function promptLabel(handle: SessionHandle): string {
  return handle.profile === IMPLICIT_PROFILE_NAME
    ? "vise"
    : `vise:${handle.profile}`;
}

/** The context a REPL command receives when it runs. */
export interface ReplContext {
  handle: SessionHandle;
}

/** Split the whitespace-separated arguments off a command line. */
export function commandArgs(input: string): string[] {
  return input.trim().split(/\s+/).slice(1);
}

/**
 * A REPL slash command. The registry is the single source of truth for both
 * dispatch (in the REPL loop) and the `/help` listing, so the two can never
 * drift apart.
 */
export interface ReplCommand {
  /** The command name, including the leading `/`. */
  name: string;
  /** One-line description shown by `/help`. */
  summary: string;
  /** Run the command; return text to print, or undefined to print nothing. */
  run: (ctx: ReplContext, args: string[]) => string | undefined;
  /**
   * If true, the command also matches when arguments follow its name (e.g.
   * `/hooks off`). Commands without it match their exact name only, so a task
   * that merely starts with a command word is still run as a task.
   */
  takesArgs?: boolean;
  /** If true, the REPL exits after running the command. */
  exits?: boolean;
}

/**
 * The REPL command registry. Adding a command here is all that's needed for it
 * to be dispatched and listed by `/help`.
 */
export const REPL_COMMANDS: ReplCommand[] = [
  {
    name: "/help",
    summary: "Show this help.",
    run: () => helpText(),
  },
  {
    name: "/context",
    summary: "Show context tokens used vs. the total window.",
    run: (ctx) => contextUsageLine(ctx.handle.session),
  },
  {
    name: "/profile",
    summary: "List profiles; `/profile <name>` switches to one.",
    run: (ctx, args) => profileCommand(ctx.handle, args),
    takesArgs: true,
  },
  {
    name: "/hooks",
    summary: "List active hooks; `/hooks off|on` disables/re-enables them.",
    run: (ctx, args) => hooksCommand(ctx.handle, args),
    takesArgs: true,
  },
  {
    name: "/init",
    summary: "Create a ./.vise/index.ts stub for this project.",
    run: () => initCommand(process.cwd(), "./.vise/index.ts"),
  },
  {
    name: "/init-global",
    summary: "Create a ~/.vise/index.ts stub shared across projects.",
    run: () => initCommand(homedir(), "~/.vise/index.ts"),
  },
  {
    name: "/exit",
    summary: "End the session (also: exit, quit, Ctrl-D).",
    run: () => undefined,
    exits: true,
  },
];

/**
 * Look up a command by its exact input. Bare `exit`/`quit` are aliases for
 * `/exit` (standard REPL convention).
 */
export function findCommand(input: string): ReplCommand | undefined {
  if (input === "exit" || input === "quit") {
    return REPL_COMMANDS.find((c) => c.name === "/exit");
  }
  const head = input.trim().split(/\s+/)[0];
  return REPL_COMMANDS.find(
    (c) => c.name === input || (c.takesArgs === true && c.name === head),
  );
}

/**
 * The text shown by the `/help` command, generated from the command registry
 * so it always matches what the REPL actually dispatches.
 */
export function helpText(): string {
  const lines = ["Commands:"];
  for (const cmd of REPL_COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(10)} ${cmd.summary}`);
  }
  lines.push("  <task>     Run a coding task (any text that isn't a command).");
  lines.push("  Ctrl-C     Abort the current turn.");
  return lines.join("\n");
}

/**
 * Format the context-usage line for the `/context` command: prompt tokens used
 * on the most recent LLM call vs. the configured context window.
 */
export function contextUsageLine(session: Session): string {
  const used = session.lastPromptTokens;
  const total = session.config.maxContext;
  if (used === null) {
    return `context: no LLM call yet (window ${total} tokens)`;
  }
  const pct = ((used / total) * 100).toFixed(1);
  return `context: ${used} / ${total} tokens (${pct}%)`;
}

/**
 * The `/profile` command (profiles spec §3.9).
 *
 * With no argument it lists every profile, marking the active one with `*`.
 * With a name it switches, re-resolving the system prompt, tool set, hooks,
 * and model. An unknown name — or one whose profile has no usable model — is
 * reported and nothing changes (spec §4).
 */
export function profileCommand(
  handle: SessionHandle,
  args: string[] = [],
): string {
  const [name, ...rest] = args;
  if (name === undefined) return profileListing(handle);
  if (rest.length > 0) {
    return `Usage: /profile [<name>] (profile names cannot contain spaces).`;
  }
  try {
    handle.switchProfile(name);
  } catch (err) {
    if (
      err instanceof UnknownProfileError ||
      err instanceof ProfileHasNoModelError
    ) {
      return err.message;
    }
    throw err;
  }
  return `profile: switched to "${name}".`;
}

/**
 * The `/profile` listing (config spec §3.9): every profile from both config
 * files plus the implicit built-in one, each marked with its origin
 * (`builtin`, `global`, or `project`), active one marked `*`, in creation
 * order (builtin, then global, then project).
 */
export function profileListing(handle: SessionHandle): string {
  const entries = handle.profileEntries();
  const width = Math.max(...entries.map((e) => e.name.length));
  const lines = ["Profiles:"];
  for (const { name, origin } of entries) {
    const marker = name === handle.profile ? "*" : " ";
    lines.push(`  ${marker} ${name.padEnd(width)} (${origin})`);
  }
  return lines.join("\n");
}

/**
 * The `/hooks` command (hooks spec §3.8): list the active profile's hooks, or
 * toggle the whole system off/on for the rest of the session. The toggle is
 * held on the session, so it survives a profile switch.
 */
export function hooksCommand(
  handle: SessionHandle,
  args: string[] = [],
): string {
  const [arg] = args;
  if (arg === "off") {
    handle.setHooksEnabled(false);
    return "hooks: disabled for this session.";
  }
  if (arg === "on") {
    handle.setHooksEnabled(true);
    return "hooks: enabled.";
  }
  if (arg !== undefined) {
    return `Unknown argument "${arg}". Usage: /hooks [on|off]`;
  }
  return hooksListing(handle.session.hooks);
}

/** The `/hooks` listing: one line per hook with its events, filters, and source. */
export function hooksListing(hooks: HookManager): string {
  const registered = hooks.list();
  if (registered.length === 0) return "hooks: none active for this profile.";
  const state = hooks.isEnabled() ? "enabled" : "disabled";
  const lines = [`hooks: ${registered.length} active (${state})`];
  for (const { hook, source, tools } of registered) {
    const flag = hook.includeSubagents ? " [subagents]" : "";
    const filter =
      tools && tools.length > 0 ? ` [tools: ${tools.join(", ")}]` : "";
    lines.push(`  ${hook.events.join(", ")}${flag}${filter} — ${source}`);
  }
  return lines.join("\n");
}

/**
 * The `/init` and `/init-global` commands: write a config stub under `root`
 * (the project root or the home directory). An existing config is never
 * overwritten — the user is told to edit it by hand instead.
 */
export function initCommand(root: string, displayName: string): string {
  return writeConfigStub(root)
    ? `created ${displayName}.`
    : `${displayName} already exists — edit it by hand.`;
}

/**
 * Condense tool-call arguments into a short one-line summary.
 */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 60 ? s.slice(0, 57) + "…" : s}`);
  }
  return parts.join(", ");
}

/**
 * Build a `SubagentRender` that writes a subagent's live output to stdout,
 * indented under the parent's `→ spawn_subagent(<task>)` line (spec §3.8.6).
 * The indent scales with the subagent's nesting depth.
 */
function makeSubagentRender(): SubagentRender {
  return (depth, event) => {
    const indent = "  ".repeat(depth);
    switch (event.kind) {
      case "token":
        process.stdout.write(event.text);
        break;
      case "toolCall":
        process.stdout.write(
          `\n${indent}  → ${event.name}(${summarizeArgs(event.args)})\n`,
        );
        break;
      case "toolResult":
        process.stdout.write(
          `${indent}  ${event.ok ? "✓" : "✗"} ${event.name}: ${event.summary}\n`,
        );
        break;
      case "compacting":
        process.stdout.write(`${indent}  [compacting context…]\n`);
        break;
      case "end":
        process.stdout.write(
          `${indent}  ${event.ok ? "✓" : "✗"} ${event.label}\n`,
        );
        break;
    }
  };
}
