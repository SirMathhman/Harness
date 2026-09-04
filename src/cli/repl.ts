import { createInterface, type Interface } from "node:readline";
import type { Config } from "../types.js";
import { runTurn, type AgentCallbacks } from "../agent/loop.js";
import { createSession } from "../agent/session.js";
import { LLMError } from "../llm/errors.js";
import { BackgroundCommandManager } from "../tools/index.js";

/**
 * Run the interactive REPL (spec §3.6).
 *
 * - Multi-turn: history is retained across prompts.
 * - Live output: streamed tokens, one line per tool call + condensed result,
 *   delimited finish answer.
 * - Ctrl-C (E15): aborts the current turn, kills the foreground command, and
 *   returns to the prompt.
 * - `exit` / `quit` end the session.
 */
export async function startRepl(
  config: Config,
  initialTask?: string | null,
): Promise<void> {
  const { session, registry, manager } = createSession(config);
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

  for (;;) {
    if (closed) break;
    const line = await prompt(rl, "harness> ");
    if (closed) break;
    const input = line.trim();
    if (input === "") continue;
    if (input === "exit" || input === "quit") break;
    if (input === "/context") {
      process.stdout.write(contextUsageLine(session) + "\n");
      continue;
    }
    await executeTurn(session, registry, manager, callbacks, input);
  }

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
