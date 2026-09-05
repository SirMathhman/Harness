import { createInterface, type Interface } from "node:readline";
import { runTurn, type AgentCallbacks } from "../agent/loop.js";
import { createSession, type SessionHandle } from "../agent/session.js";
import type { SubagentRender } from "../agent/subagent.js";
import { LLMError } from "../llm/errors.js";
import {
  IMPLICIT_PROFILE_NAME,
  writeStateFile,
  type ResourceGraph,
} from "../profiles/index.js";
import { commandArgs, findCommand, type ReplContext } from "./commands.js";

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
