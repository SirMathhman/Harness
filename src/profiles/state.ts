import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_DIR, findConfigEntry } from "./load.js";
import { IMPLICIT_PROFILE_NAME, type ResourceGraph } from "./registry.js";

/** The persisted session state (config spec §3.8.2). */
export interface StateFile {
  /** The name of the active profile at exit. `"Agent"` for the implicit one. */
  profile: string;
  /** ISO 8601 timestamp of when the state was saved. */
  savedAt: string;
  /** The model name in use at exit, used to pin auto-discovery on restart. */
  lastModel: string;
}

/** What starting-profile resolution (config spec §3.7) produced. */
export interface StartingProfile {
  /** The profile name the session should start under. */
  profile: string;
  /**
   * The model name saved alongside `profile`, or null when there was no
   * (usable) saved state. Pins auto-discovery (spec §3.8.4).
   */
  lastModel: string | null;
}

/** Where warnings from state-file handling go, unless a caller overrides it. */
const defaultLog = (message: string): void => {
  console.error(message);
};

/**
 * The state file's location (config spec §3.8.1): project-local when a
 * project config exists, else global — so a "no project" session still
 * remembers its last profile without scattering a `.vise/` into every
 * directory Vise happens to run from.
 */
export function stateFilePath(
  root: string = process.cwd(),
  globalRoot: string = homedir(),
): string {
  return findConfigEntry(root) !== null
    ? path.join(root, CONFIG_DIR, "state.json")
    : path.join(globalRoot, CONFIG_DIR, "state.json");
}

/**
 * Resolve the profile a session starts under (config spec §3.7): the state
 * file's saved profile if it exists, is well-formed, and still names a
 * profile in `graph`; otherwise the implicit built-in profile, with a warning
 * to `log` naming why the saved state was not used.
 */
export function resolveStartingProfile(
  graph: ResourceGraph,
  statePath: string,
  log: (message: string) => void = defaultLog,
): StartingProfile {
  const fallback: StartingProfile = {
    profile: IMPLICIT_PROFILE_NAME,
    lastModel: null,
  };

  if (!existsSync(statePath)) return fallback;

  const unreadable = (): StartingProfile => {
    log(
      `Warning: could not read state file (${statePath}). Starting with the default profile.`,
    );
    return fallback;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return unreadable();
  }
  if (!isStateFile(parsed)) return unreadable();

  if (!graph.profiles.has(parsed.profile)) {
    log(
      `Warning: saved profile "${parsed.profile}" not found in config. ` +
        `Starting with the default profile.`,
    );
    // The implicit profile's model is auto-discovered, so the saved
    // lastModel still pins it (config spec §3.8.2, §3.8.4): a restart
    // restores the same model even though the saved profile is gone.
    return { profile: IMPLICIT_PROFILE_NAME, lastModel: parsed.lastModel };
  }

  return { profile: parsed.profile, lastModel: parsed.lastModel };
}

/**
 * Save the active profile and model on a clean exit (config spec §3.8.3). A
 * write failure is reported through `log` and otherwise ignored — the exit
 * proceeds either way.
 */
export function writeStateFile(
  statePath: string,
  profile: string,
  lastModel: string,
  log: (message: string) => void = defaultLog,
): void {
  const state: StateFile = {
    profile,
    savedAt: new Date().toISOString(),
    lastModel,
  };
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    log(
      `Warning: could not save state to ${statePath}: ${(err as Error).message}.`,
    );
  }
}

/** Shape-check a parsed state file (config spec §3.8.4, C9). */
function isStateFile(value: unknown): value is StateFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.profile === "string" &&
    typeof v.savedAt === "string" &&
    typeof v.lastModel === "string"
  );
}
