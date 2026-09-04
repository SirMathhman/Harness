import { createInterface, type Interface } from "node:readline";
import type { Config } from "../types.js";
import { runTurn, type AgentCallbacks } from "../agent/loop.js";
import { createSession } from "../agent/session.js";
import type { SubagentRender } from "../agent/subagent.js";
import { LLMError } from "../llm/errors.js";
import { BackgroundCommandManager } from "../tools/index.js";
import { HookManager } from "../hooks/index.js";

/**
 * Run the interactive REPL (spec §3.6).
 *
 * - Multi-turn: history is retained across prompts.
 * - Live output: streamed tokens, one line per tool call + condensed result,
 *   delimited finish answer.
 * - Ctrl-C (E15): aborts the current turn, kills the foreground command, and
 *   returns to the prompt.
 * - `exit` / `quit` end the session.
 *
 * `hooks` holds the session's already-loaded lifecycle hooks (hooks spec
 * §3.9); omitted → an empty, inert manager.
 */
export async function startRepl(
  config: Config,
  initialTask?: string | null,
  hooks: HookManager = new HookManager(),
): Promise<void> {
  const { session, registry, manager } = createSession(config, {
    render: makeSubagentRender(),
    hooks,
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
    await executeTurn(session, registry, manager, callbacks, initialTask);
  }

  const ctx: ReplContext = { session };
  for (;;) {
    if (closed) break;
    const line = await prompt(rl, "harness> ");
    if (closed) break;
    const input = line.trim();
    if (input === "") continue;
    const cmd = findCommand(input);
    if (cmd) {
      const out = cmd.run(ctx, commandArgs(input));
      if (out !== undefined) process.stdout.write(out + "\n");
      if (cmd.exits) break;
      continue;
    }
    await executeTurn(session, registry, manager, callbacks, input);
  }

  // session:end (hooks §3.1): a block is ignored, but the message is shown —
  // the session is ending, so there is no conversation left to inject it into.
  const ended = session.hooks.dispatch("session:end", { depth: 0 });
  if (ended.advisory) process.stdout.write(`${ended.advisory}\n`);

  manager.killAll();
  rl.close();
}

/**
 * Run a single turn with Ctrl-C handling (E15): aborts the turn and kills the
 * foreground command, then returns to the prompt.
 */
async function executeTurn(
  session: ReturnType<typeof createSession>["session"],
  registry: ReturnType<typeof createSession>["registry"],
  manager: BackgroundCommandManager,
  callbacks: AgentCallbacks,
  input: string,
): Promise<void> {
  const ac = new AbortController();
  const onSigint = () => {
    ac.abort();
    manager.killAll();
    process.stdout.write("\n[interrupted]\n");
  };
  process.on("SIGINT", onSigint);

  try {
    const result = await runTurn(
      session,
      input,
      registry,
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

/**
 * The context a REPL command receives when it runs.
 */
export interface ReplContext {
  session: ReturnType<typeof createSession>["session"];
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
    run: (ctx) => contextUsageLine(ctx.session),
  },
  {
    name: "/hooks",
    summary: "List registered hooks; `/hooks off|on` disables/re-enables them.",
    run: (ctx, args) => hooksCommand(ctx.session.hooks, args),
    takesArgs: true,
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
export function contextUsageLine(
  session: ReturnType<typeof createSession>["session"],
): string {
  const used = session.lastPromptTokens;
  const total = session.config.maxContext;
  if (used === null) {
    return `context: no LLM call yet (window ${total} tokens)`;
  }
  const pct = ((used / total) * 100).toFixed(1);
  return `context: ${used} / ${total} tokens (${pct}%)`;
}

/**
 * The `/hooks` command (hooks spec §3.8): list the registered hooks, or
 * toggle the whole system off/on for the rest of the session.
 */
export function hooksCommand(hooks: HookManager, args: string[] = []): string {
  const [arg] = args;
  if (arg === "off") {
    hooks.setEnabled(false);
    return "hooks: disabled for this session.";
  }
  if (arg === "on") {
    hooks.setEnabled(true);
    return "hooks: enabled.";
  }
  if (arg !== undefined) {
    return `Unknown argument "${arg}". Usage: /hooks [on|off]`;
  }
  return hooksListing(hooks);
}

/** The `/hooks` listing: one line per hook with its events, flag, and file. */
export function hooksListing(hooks: HookManager): string {
  const registered = hooks.list();
  if (registered.length === 0) return "hooks: none registered.";
  const state = hooks.isEnabled() ? "enabled" : "disabled";
  const lines = [`hooks: ${registered.length} registered (${state})`];
  for (const { hook, source } of registered) {
    const flag = hook.includeSubagents ? " [subagents]" : "";
    lines.push(`  ${hook.events.join(", ")}${flag} — ${source}`);
  }
  return lines.join("\n");
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
