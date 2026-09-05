import { homedir } from "node:os";
import type { Session, Skill } from "../types.js";
import type { SessionHandle } from "../agent/session.js";
import { HookManager } from "../hooks/index.js";
import {
  AmbiguousModelError,
  MissingMaxContextError,
  ModelNotAvailableError,
  ProfileHasNoModelError,
  UnknownModelError,
  UnknownProfileError,
  writeConfigStub,
  type ResourceId,
} from "../profiles/index.js";

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
    name: "/clear",
    summary: "Clear the conversation (keeps the system prompt).",
    run: (ctx) => {
      ctx.handle.clearConversation();
      return "conversation cleared.";
    },
  },
  {
    name: "/profile",
    summary: "List profiles; `/profile <name>` switches to one.",
    run: (ctx, args) => profileCommand(ctx.handle, args),
    takesArgs: true,
  },
  {
    name: "/model",
    summary: "List models; `/model <name>` switches the active model.",
    run: (ctx, args) => modelCommand(ctx.handle, args),
    takesArgs: true,
  },
  {
    name: "/skills",
    summary: "List the skills available to the agent.",
    run: (ctx) => skillsListing(ctx.handle.skills()),
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
      err instanceof ProfileHasNoModelError ||
      err instanceof MissingMaxContextError
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
 * The `/model` command (providers spec §3.8).
 *
 * With no argument it lists every discovered/declared model, grouped by
 * provider, marking the active one with `*`. With a name — a bare model name,
 * or `<provider>/<name>` to disambiguate — it switches the session to that
 * model, adopting its whole resource (`baseUrl`, `apiKey`, `temperature`,
 * `maxContext`) while keeping the conversation and system prompt. An unknown
 * name, an ambiguous one, or one outside the active profile's `models`
 * whitelist is reported and nothing changes.
 */
export function modelCommand(
  handle: SessionHandle,
  args: string[] = [],
): string {
  const [name, ...rest] = args;
  if (name === undefined) return modelListing(handle);
  if (rest.length > 0) {
    return `Usage: /model [<name>] (model names cannot contain spaces).`;
  }
  try {
    handle.switchModel(name);
  } catch (err) {
    if (
      err instanceof UnknownModelError ||
      err instanceof AmbiguousModelError ||
      err instanceof ModelNotAvailableError ||
      err instanceof MissingMaxContextError
    ) {
      return err.message;
    }
    throw err;
  }
  return `model: switched to "${name}".`;
}

/**
 * The `/model` listing (providers spec §3.8): every discovered/declared
 * model, grouped by the provider that discovered it (or "(no provider)" for
 * one declared directly via `reg.createModel()`), the active one marked `*`.
 *
 * ```
 * Models:
 *   llama_0 (http://localhost:8080):
 *     * qwen2.5-coder-32b
 *     llama-3-70b
 *   openrouter (https://openrouter.ai/api/v1):
 *     anthropic/claude-sonnet-4
 * ```
 */
export function modelListing(handle: SessionHandle): string {
  const entries = handle.modelEntries();
  const activeId = handle.activeModelId();
  if (entries.length === 0) {
    return `models: none available (active: ${
      handle.session.config.model ?? "none"
    }).`;
  }

  // Grouped by (provider, baseUrl): every model from a real provider shares
  // one baseUrl, but two explicit `reg.createModel()` models (no provider)
  // can point at different servers, so they only share a group when their
  // baseUrl also matches.
  const groups = new Map<
    string,
    { label: string; baseUrl: string; rows: { id: ResourceId; name: string }[] }
  >();
  for (const entry of entries) {
    const label = entry.providerName ?? "(no provider)";
    const key = `${label} ${entry.baseUrl}`;
    let group = groups.get(key);
    if (!group) {
      group = { label, baseUrl: entry.baseUrl, rows: [] };
      groups.set(key, group);
    }
    group.rows.push({ id: entry.id, name: entry.name });
  }

  const lines = ["Models:"];
  for (const { label, baseUrl, rows } of groups.values()) {
    lines.push(`  ${label} (${baseUrl}):`);
    for (const { id, name } of rows) {
      const marker = id === activeId ? "*" : " ";
      lines.push(`    ${marker} ${name}`);
    }
  }
  return lines.join("\n");
}

/**
 * The `/skills` listing (skills spec §3.6): every skill in the session, name
 * and description, in creation order (global first, then project). Read-only —
 * it never touches the session.
 *
 * ```
 * Skills:
 *   madge       How to use the madge npm package for dependency analysis
 *   npm-deps    Managing npm dependencies in this project
 * ```
 */
export function skillsListing(skills: readonly Skill[]): string {
  if (skills.length === 0) return "No skills defined.";
  const width = Math.max(...skills.map((s) => s.name.length)) + 4;
  const lines = ["Skills:"];
  for (const { name, description } of skills) {
    lines.push(`  ${name.padEnd(width)}${description}`);
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
