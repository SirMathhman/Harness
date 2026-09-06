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
import { c } from "./color.js";
import { commandArgs, findCommand, type ReplContext } from "./commands.js";
import {
  compactingLine,
  reasoningHeaderLine,
  subagentEndLine,
  toolCallLine,
  toolResultLine,
  writeLine,
} from "./render.js";

/**
 * Whether `readline`'s own terminal handling (raw-mode input + its own
 * per-keystroke echo) should be turned off, leaving the console's native
 * cooked-mode echo as the only one.
 *
 * `readline` echoes each keystroke itself when `terminal: true` (the default
 * for a TTY), which normally works because it also puts the terminal into
 * raw mode, suppressing the OS's own echo. Two environments are known not to
 * honor that raw-mode request, so the OS keeps echoing on top of readline's
 * echo and every keystroke shows up doubled (confirmed via `bun run` in a
 * plain Windows PowerShell console: "test" renders as "tteesstt"):
 *
 * - Running under **Bun on Windows** (`bun run src/index.ts`): Bun's stdin
 *   handling on `win32` doesn't reliably disable the Windows console's own
 *   `ENABLE_ECHO_INPUT`, regardless of the shell hosting it.
 * - An **MSYS2/mintty-based shell** (Git Bash, `MSYSTEM` set to e.g.
 *   `MINGW64`): its pty layer doesn't relay the raw-mode request either.
 *
 * The console's own cooked-mode line editing (typing, backspace, Enter)
 * still works fine with `terminal: false`; only readline's own history/
 * line-editing niceties are lost, which is the right trade to make here.
 */
function shouldDisableReadlineEcho(): boolean {
  const isBunOnWindows =
    process.platform === "win32" && typeof process.versions.bun === "string";
  const isMsysPty =
    typeof process.env.MSYSTEM === "string" && process.env.MSYSTEM !== "";
  return isBunOnWindows || isMsysPty;
}

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
 * `graph` is the resource graph built from `.vise/index.ts`, including every
 * model discovered from its providers (providers spec §3.6); omitted → the
 * built-in defaults (profiles spec §3.8). `profile` is the starting profile,
 * already resolved from the state file (config spec §3.7); `statePath` is
 * where that profile and the active model are saved back to on a clean exit
 * (config spec §3.8.3). `lastModel` is the model name saved alongside it,
 * used to pin the active model whenever a profile is (re)selected (providers
 * spec §3.4, §3.9).
 */
export async function startRepl(
  graph: ResourceGraph,
  profile: string,
  statePath: string,
  lastModel: string | null,
  initialTask?: string | null,
): Promise<void> {
  const handle = createSession({
    graph,
    profile,
    lastModel,
    render: makeSubagentRender(),
    log: (message) => process.stderr.write(`${c.yellow(message)}\n`),
  });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true && !shouldDisableReadlineEcho(),
  });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  // Reasoning is display-only: it streams in gray and is never sent back to
  // the model. `reasoningActive` tracks the reasoning→content transition so
  // the answer starts on a fresh line; it is reset at the start of each turn.
  let reasoningActive = false;
  const callbacks: AgentCallbacks = {
    onToken: (t) => {
      if (reasoningActive) {
        process.stdout.write("\n");
        reasoningActive = false;
      }
      process.stdout.write(t);
    },
    onReasoning: (t) => {
      if (!reasoningActive) {
        process.stdout.write(`\n${reasoningHeaderLine()}\n`);
        reasoningActive = true;
      }
      process.stdout.write(c.gray(t));
    },
    onToolCall: (name, args) =>
      process.stdout.write(`\n${toolCallLine(name, args)}\n`),
    onToolResult: (name, ok, summary) =>
      writeLine(toolResultLine(name, ok, summary)),
    onCompacting: () => process.stdout.write(`\n${compactingLine()}\n`),
  };

  // Run an initial task if one was passed on the command line.
  if (initialTask) {
    reasoningActive = false;
    await executeTurn(handle, callbacks, initialTask);
  }

  const ctx: ReplContext = { handle };
  for (;;) {
    if (closed) break;
    const line = await prompt(rl, `${c.bold(c.cyan(promptLabel(handle)))}> `);
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
    reasoningActive = false;
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
    process.stdout.write(`\n${c.yellow("[interrupted]")}\n`);
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
    } else if (result.kind === "text") {
      // Answer was already streamed via onToken; just ensure a trailing newline.
      process.stdout.write("\n");
    } else {
      // "cap": answer was not streamed, write it now.
      process.stdout.write(`\n${result.answer}\n`);
    }
  } catch (err) {
    if (err instanceof LLMError) {
      process.stdout.write(`\n${c.red("[LLM error]")} ${err.message}\n`);
    } else if (!ac.signal.aborted) {
      process.stdout.write(`\n${c.red("[error]")} ${(err as Error).message}\n`);
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
 * Build a `SubagentRender` that writes a subagent's live output to stdout,
 * indented under the parent's `→ spawn_subagent(<task>)` line (spec §3.8.6).
 * The indent scales with the subagent's nesting depth.
 */
function makeSubagentRender(): SubagentRender {
  // Per-depth reasoning→content transition, mirroring the main-agent path:
  // reasoning streams in gray under a `thinking…` header, and the first
  // content token after reasoning starts on a fresh line.
  const reasoningActive = new Map<number, boolean>();
  return (depth, event) => {
    const indent = "  ".repeat(depth) + "  ";
    switch (event.kind) {
      case "token":
        if (reasoningActive.get(depth)) {
          process.stdout.write("\n");
          reasoningActive.set(depth, false);
        }
        process.stdout.write(event.text);
        break;
      case "reasoning":
        if (!reasoningActive.get(depth)) {
          process.stdout.write(`\n${reasoningHeaderLine(indent)}\n`);
          reasoningActive.set(depth, true);
        }
        process.stdout.write(c.gray(event.text));
        break;
      case "toolCall":
        process.stdout.write(
          `\n${toolCallLine(event.name, event.args, indent)}\n`,
        );
        break;
      case "toolResult":
        writeLine(toolResultLine(event.name, event.ok, event.summary, indent));
        break;
      case "compacting":
        writeLine(compactingLine(indent));
        break;
      case "end":
        writeLine(subagentEndLine(event.ok, event.label, indent));
        break;
    }
  };
}
