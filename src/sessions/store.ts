import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_DIR, findConfigEntry } from "../profiles/load.js";
import type { Message } from "../types.js";
import type { SessionHandle } from "../agent/session.js";

/**
 * The in-memory representation of one saved session (spec §2.1). It is stored
 * verbatim as a JSON file; there is no wrapper or envelope.
 */
export interface SavedSession {
  /** Format version. `1` for this release. */
  version: 1;
  /** The session identifier; unique within a store. Equals the filename stem. */
  name: string;
  /** Human-readable label shown in listings. Defaults to `name` at save time. */
  title: string;
  /** The profile name active at save time. */
  profile: string;
  /** The model name active at save time. `""` if none was pinned. */
  model: string;
  /** ISO 8601 timestamp of when the session was saved. */
  savedAt: string;
  /** The conversation, excluding all leading system messages (spec §3.3 R1). */
  messages: Message[];
}

/** A row in a session listing (spec §3.1 `/sessions`). */
export interface SessionInfo {
  name: string;
  title: string;
  model: string;
  savedAt: string;
  /** False when the file exists but could not be parsed (corrupt/version). */
  readable: boolean;
}

/**
 * A typed failure from the session store, so callers can branch on `reason`
 * for specific UX (e.g. "not-found" → list sessions; "corrupt" → offer delete).
 */
export class SessionError extends Error {
  constructor(
    public readonly reason:
      | "not-found"
      | "corrupt"
      | "version-mismatch"
      | "invalid-shape"
      | "invalid-name"
      | "exists",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * The sessions directory (spec §2.2): project-local when a project config
 * exists, else global — the same rule the old `state.json` used.
 */
export function sessionsDir(
  root: string = process.cwd(),
  globalRoot: string = homedir(),
): string {
  return findConfigEntry(root) !== null
    ? path.join(root, CONFIG_DIR, "sessions")
    : path.join(globalRoot, CONFIG_DIR, "sessions");
}

/**
 * Sanitize a user-supplied name to a safe filename stem (spec §3.3 R5): strip
 * path separators and other filesystem-unsafe characters, then trim. Throws
 * `SessionError("invalid-name")` when the result is empty.
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    // Path separators, Windows-reserved characters, and control characters.
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .trim();
  if (cleaned.length === 0) {
    throw new SessionError(
      "invalid-name",
      `Session name "${raw}" is not a valid name.`,
    );
  }
  return cleaned;
}

/**
 * Generate a timestamp-derived name for an unnamed save (spec §3.3 R4), e.g.
 * `2026-02-26T12-00-00-000Z`, so repeated unnamed saves do not collide.
 */
export function autoName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Drop all leading system messages (spec §3.3 R1). The same set
 * `clearConversation` keeps; the system prompt is re-derived at load time.
 */
export function stripSystemMessages(messages: Message[]): Message[] {
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    i++;
  }
  return messages.slice(i);
}

/** True when `value` is a well-formed domain `Message`. */
function isValidMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (
    m.role !== "system" &&
    m.role !== "user" &&
    m.role !== "assistant" &&
    m.role !== "tool"
  ) {
    return false;
  }
  if (m.content !== null && typeof m.content !== "string") return false;
  return true;
}

/** True when `value` is a well-formed `SavedSession` of the current version. */
function isSavedSession(value: unknown): value is SavedSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (typeof s.name !== "string" || s.name.length === 0) return false;
  if (typeof s.title !== "string") return false;
  if (typeof s.profile !== "string") return false;
  if (typeof s.model !== "string") return false;
  if (typeof s.savedAt !== "string") return false;
  if (!Array.isArray(s.messages)) return false;
  return (s.messages as unknown[]).every(isValidMessage);
}

/**
 * Write `saved` to `<dir>/<name>.json`, creating `dir` if needed (spec §2.2).
 * A save is idempotent per name: an existing file is overwritten (E8).
 */
export function saveSession(dir: string, saved: SavedSession): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${saved.name}.json`);
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
}

/**
 * Read and validate `<dir>/<name>.json` (spec §4). Throws `SessionError` with
 * a `reason` of `"not-found"`, `"corrupt"`, `"version-mismatch"`, or
 * `"invalid-shape"` on failure.
 */
export function loadSession(dir: string, name: string): SavedSession {
  const file = path.join(dir, `${name}.json`);
  if (!existsSync(file)) {
    throw new SessionError("not-found", `No session named "${name}".`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new SessionError(
      "corrupt",
      `Session "${name}" is not valid JSON and could not be read.`,
    );
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { version?: unknown }).version !== 1
  ) {
    throw new SessionError(
      "version-mismatch",
      `Session "${name}" was written by an incompatible Vise version.`,
    );
  }
  if (!isSavedSession(parsed)) {
    throw new SessionError(
      "invalid-shape",
      `Session "${name}" is missing required fields and could not be read.`,
    );
  }
  return parsed;
}

/**
 * List every session in `dir` (spec §3.1 `/sessions`). Corrupt or
 * version-mismatched files are returned with `readable: false` rather than
 * throwing (E2, E3). An empty or missing directory yields an empty array.
 */
export function listSessions(dir: string): SessionInfo[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: SessionInfo[] = [];
  for (const file of files) {
    const name = file.slice(0, -".json".length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch {
      out.push({
        name,
        title: "(unreadable)",
        model: "",
        savedAt: "",
        readable: false,
      });
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version !== 1
    ) {
      out.push({
        name,
        title: "(unreadable)",
        model: "",
        savedAt: "",
        readable: false,
      });
      continue;
    }
    if (!isSavedSession(parsed)) {
      out.push({
        name,
        title: "(unreadable)",
        model: "",
        savedAt: "",
        readable: false,
      });
      continue;
    }
    out.push({
      name: parsed.name,
      title: parsed.title,
      model: parsed.model,
      savedAt: parsed.savedAt,
      readable: true,
    });
  }
  return out;
}

/**
 * Rename a session (spec §3.1 `/rename`): updates the filename and the
 * `name`/`title` fields. Throws `SessionError("not-found")` when `oldName`
 * does not exist, and `SessionError("exists")` when `newName` does (E9, E10).
 */
export function renameSession(
  dir: string,
  oldName: string,
  newName: string,
): void {
  const oldFile = path.join(dir, `${oldName}.json`);
  if (!existsSync(oldFile)) {
    throw new SessionError("not-found", `No session named "${oldName}".`);
  }
  const cleanNew = sanitizeName(newName);
  const newFile = path.join(dir, `${cleanNew}.json`);
  if (existsSync(newFile)) {
    throw new SessionError(
      "exists",
      `A session named "${cleanNew}" already exists.`,
    );
  }
  const saved = loadSession(dir, oldName);
  renameSync(oldFile, newFile);
  saveSession(dir, { ...saved, name: cleanNew, title: cleanNew });
}

/**
 * Delete a session file (spec §3.1 `/delete`). Throws
 * `SessionError("not-found")` when the name does not exist (E11). Deleting the
 * reserved `last` is allowed (E12).
 */
export function deleteSession(dir: string, name: string): void {
  const file = path.join(dir, `${name}.json`);
  if (!existsSync(file)) {
    throw new SessionError("not-found", `No session named "${name}".`);
  }
  unlinkSync(file);
}

/**
 * Auto-save the current conversation under the reserved name `last` on a clean
 * exit (spec §3.3 R7, R8; W4). Skipped when the conversation has no
 * non-system messages, so an empty session never writes (or clobbers) `last`.
 */
export function autoSaveLast(dir: string, handle: SessionHandle): void {
  const messages = stripSystemMessages(handle.session.messages);
  if (messages.length === 0) return;
  const saved: SavedSession = {
    version: 1,
    name: "last",
    title: "last",
    profile: handle.session.profile,
    model: handle.session.config.model ?? "",
    savedAt: new Date().toISOString(),
    messages,
  };
  saveSession(dir, saved);
}
