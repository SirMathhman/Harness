import { homedir } from "node:os";
import type { Session, Skill } from "../types.js";
import type { SessionHandle } from "../agent/session.js";
import { HookManager } from "../hooks/index.js";
import {
  AmbiguousModelError,
  IMPLICIT_PROFILE_NAME,
  MissingMaxContextError,
  ModelNotAvailableError,
  ProfileHasNoModelError,
  UnknownModelError,
  UnknownProfileError,
  writeConfigStub,
  type ResourceId,
} from "../profiles/index.js";
import {
  autoName,
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
  sanitizeName,
  saveSession,
  stripSystemMessages,
  SessionError,
  type SavedSession,
  type SessionInfo,
} from "../sessions/index.js";

/** The context a REPL command receives when it runs. */
export interface ReplContext {
  handle: SessionHandle;
  /** The sessions store directory (spec §2.2), computed once at REPL start. */
  sessionsDir: string;
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
    name: "/save",
    summary: "Save the conversation; `/save <name>` names it.",
    run: (ctx, args) => saveCommand(ctx, args),
    takesArgs: true,
  },
  {
    name: "/load",
    summary: "Load a saved session, replacing the conversation.",
    run: (ctx, args) => loadCommand(ctx, args),
    takesArgs: true,
  },
  {
    name: "/sessions",
    summary: "List saved sessions.",
    run: (ctx) => sessionsCommand(ctx),
  },
  {
    name: "/rename",
    summary: "Rename a saved session: `/rename <old> <new>`.",
    run: (ctx, args) => renameCommand(ctx, args),
    takesArgs: true,
  },
  {
    name: "/delete",
    summary: "Delete a saved session: `/delete <name>`.",
    run: (ctx, args) => deleteCommand(ctx, args),
    takesArgs: true,
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

/**
 * The `/save` command (spec §3.1, W1): persist the current conversation,
 * stripping the leading system message(s) (R1). With no argument the name is
 * auto-generated from the timestamp (R4); with one it is sanitized (R5). A
 * save is idempotent per name — an existing file is overwritten (E8).
 */
export function saveCommand(ctx: ReplContext, args: string[] = []): string {
  const [name, ...rest] = args;
  if (rest.length > 0) {
    return "Usage: /save [<name>] (session names cannot contain spaces).";
  }
  let clean: string;
  try {
    clean = name === undefined ? autoName() : sanitizeName(name);
  } catch (err) {
    if (err instanceof SessionError) return err.message;
    throw err;
  }
  const messages = stripSystemMessages(ctx.handle.session.messages);
  const saved: SavedSession = {
    version: 1,
    name: clean,
    title: clean,
    profile: ctx.handle.session.profile,
    model: ctx.handle.session.config.model ?? "",
    savedAt: new Date().toISOString(),
    messages,
  };
  try {
    saveSession(ctx.sessionsDir, saved);
  } catch (err) {
    return `Could not save session: ${(err as Error).message}.`;
  }
  return `saved session "${clean}" (${messages.length} messages).`;
}

/**
 * The `/load` command (spec §3.1, W3): read and validate a saved session,
 * then replace the current conversation with it (R2, R3). A missing name
 * reports the error and lists the sessions that do exist (E1); a stale
 * profile or model warns and falls back (R6, E5, E6).
 */
export function loadCommand(ctx: ReplContext, args: string[] = []): string {
  const [name, ...rest] = args;
  if (name === undefined) {
    return "Usage: /load <name> (see /sessions for available names).";
  }
  if (rest.length > 0) {
    return "Usage: /load <name> (session names cannot contain spaces).";
  }
  let saved: SavedSession;
  try {
    saved = loadSession(ctx.sessionsDir, name);
  } catch (err) {
    if (err instanceof SessionError) {
      const list = sessionsListing(listSessions(ctx.sessionsDir));
      return `${err.message}\n${list}`;
    }
    return `Could not load session: ${(err as Error).message}.`;
  }

  // R6: fall back to the built-in profile when the saved one is gone.
  const profiles = ctx.handle.profiles();
  let profile = saved.profile;
  const warnings: string[] = [];
  if (!profiles.includes(profile)) {
    warnings.push(
      `Warning: saved profile "${profile}" not found; using "${IMPLICIT_PROFILE_NAME}".`,
    );
    profile = IMPLICIT_PROFILE_NAME;
  }

  // R6: warn when the saved model is no longer available.
  let model: string | null = saved.model === "" ? null : saved.model;
  if (model !== null) {
    const available = ctx.handle
      .modelEntries()
      .map((e) => e.name)
      .includes(model);
    if (!available) {
      warnings.push(
        `Warning: saved model "${model}" not available; using the profile's default.`,
      );
      model = null;
    }
  }

  try {
    ctx.handle.loadConversation(saved.messages, profile, model);
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
  const lines = [
    ...warnings,
    `loaded session "${name}" (profile: ${profile}, model: ${
      ctx.handle.session.config.model ?? "none"
    }, ${saved.messages.length} messages).`,
  ];
  return lines.join("\n");
}

/**
 * The `/sessions` command (spec §3.1, W2): list every saved session as a
 * table of name / title / model / savedAt. Corrupt files are shown as
 * unreadable (E2, E3). An empty store prints an empty-state message.
 */
export function sessionsCommand(ctx: ReplContext): string {
  return sessionsListing(listSessions(ctx.sessionsDir));
}

/** Format a session listing as a table (spec §3.1 `/sessions`). */
export function sessionsListing(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return "No saved sessions.";
  const nameW = Math.max(...sessions.map((s) => s.name.length));
  const titleW = Math.max(...sessions.map((s) => s.title.length));
  const lines = ["Sessions:"];
  for (const s of sessions) {
    if (!s.readable) {
      lines.push(`  ${s.name.padEnd(nameW)}  (unreadable)`);
      continue;
    }
    lines.push(
      `  ${s.name.padEnd(nameW)}  ${s.title.padEnd(titleW)}  ${s.model}  ${s.savedAt}`,
    );
  }
  return lines.join("\n");
}

/**
 * The `/rename` command (spec §3.1): rename a saved session, updating the
 * filename and `name`/`title`. A missing source lists the available sessions
 * (E9); renaming onto an existing name is rejected (E10).
 */
export function renameCommand(ctx: ReplContext, args: string[] = []): string {
  const [oldName, newName, ...rest] = args;
  if (oldName === undefined || newName === undefined) {
    return "Usage: /rename <old> <new>.";
  }
  if (rest.length > 0) {
    return "Usage: /rename <old> <new> (session names cannot contain spaces).";
  }
  try {
    renameSession(ctx.sessionsDir, oldName, newName);
  } catch (err) {
    if (err instanceof SessionError) {
      if (err.reason === "not-found") {
        return `${err.message}\n${sessionsListing(listSessions(ctx.sessionsDir))}`;
      }
      return err.message;
    }
    return `Could not rename session: ${(err as Error).message}.`;
  }
  return `renamed session "${oldName}" to "${newName}".`;
}

/**
 * The `/delete` command (spec §3.1): remove a saved session file. A missing
 * name reports the error and lists the available sessions (E11). Deleting the
 * reserved `last` is allowed (E12).
 */
export function deleteCommand(ctx: ReplContext, args: string[] = []): string {
  const [name, ...rest] = args;
  if (name === undefined) {
    return "Usage: /delete <name>.";
  }
  if (rest.length > 0) {
    return "Usage: /delete <name> (session names cannot contain spaces).";
  }
  try {
    deleteSession(ctx.sessionsDir, name);
  } catch (err) {
    if (err instanceof SessionError) {
      if (err.reason === "not-found") {
        return `${err.message}\n${sessionsListing(listSessions(ctx.sessionsDir))}`;
      }
      return err.message;
    }
    return `Could not delete session: ${(err as Error).message}.`;
  }
  return `deleted session "${name}".`;
}
