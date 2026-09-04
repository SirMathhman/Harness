import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HookManager,
  type HookManagerOptions,
  type RegisteredHook,
} from "./manager.js";
import { HOOK_EVENTS, isHookEvent, type Hook } from "./types.js";

/**
 * A hook file that could not be loaded or is malformed (hooks spec §3.3).
 * Fatal: the harness exits rather than running with half a hook set.
 */
export class HookLoadError extends Error {}

/**
 * Load one hook file and validate its default export (hooks spec §3.3).
 *
 * `filePath` is resolved against `root` when relative. Every failure — missing
 * file, import error, wrong export shape, malformed entry — throws a
 * `HookLoadError` naming the file and the problem.
 */
export async function loadHookFile(
  filePath: string,
  root: string = process.cwd(),
): Promise<RegisteredHook[]> {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);

  if (!existsSync(absolute)) {
    throw new HookLoadError(`Hook file not found: ${filePath} (${absolute}).`);
  }

  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(absolute).href)) as {
      default?: unknown;
    };
  } catch (err) {
    throw new HookLoadError(
      `Failed to load hook file ${filePath}: ${(err as Error).message}`,
    );
  }

  const exported = module.default;
  if (exported === undefined) {
    throw new HookLoadError(
      `Hook file ${filePath} has no default export. It must default-export an ` +
        `array of hooks.`,
    );
  }
  if (!Array.isArray(exported)) {
    throw new HookLoadError(
      `Hook file ${filePath} must default-export an array of hooks (got ` +
        `${describe(exported)}).`,
    );
  }

  return exported.map((entry, index) => ({
    hook: validateHook(entry, index, filePath),
    source: filePath,
  }));
}

/**
 * Load every configured hook file, in config order, with the hooks of each
 * file in array order (hooks spec §3.3).
 */
export async function loadHooks(
  paths: readonly string[],
  root: string = process.cwd(),
): Promise<RegisteredHook[]> {
  const loaded: RegisteredHook[] = [];
  for (const filePath of paths) {
    loaded.push(...(await loadHookFile(filePath, root)));
  }
  return loaded;
}

/**
 * Build the session's `HookManager` from the configured hook paths
 * (hooks spec §3.9).
 *
 * With no paths configured nothing is imported at all, so an unconfigured
 * harness does no file I/O and holds no hooks.
 */
export async function createHookManager(
  paths: readonly string[] | undefined,
  options: HookManagerOptions = {},
): Promise<HookManager> {
  if (paths === undefined || paths.length === 0) {
    return new HookManager([], options);
  }
  return new HookManager(await loadHooks(paths, options.cwd), options);
}

/** Validate one entry of a hook file's default export (hooks spec §3.3). */
function validateHook(value: unknown, index: number, source: string): Hook {
  const where = `Hook #${index} in ${source}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HookLoadError(`${where} must be an object (got ${describe(value)}).`);
  }

  const { events, handler, includeSubagents } = value as Record<string, unknown>;

  if (!Array.isArray(events) || events.length === 0) {
    throw new HookLoadError(
      `${where} must have a non-empty "events" array. Valid events: ` +
        `${HOOK_EVENTS.join(", ")}.`,
    );
  }
  for (const event of events) {
    if (!isHookEvent(event)) {
      throw new HookLoadError(
        `${where} has an invalid event ${JSON.stringify(event)}. Valid ` +
          `events: ${HOOK_EVENTS.join(", ")}.`,
      );
    }
  }

  if (typeof handler !== "function") {
    throw new HookLoadError(
      `${where} must have a "handler" function (got ${describe(handler)}).`,
    );
  }

  if (includeSubagents !== undefined && typeof includeSubagents !== "boolean") {
    throw new HookLoadError(
      `${where} has a non-boolean "includeSubagents" (got ` +
        `${describe(includeSubagents)}).`,
    );
  }

  return value as unknown as Hook;
}

/** A short, human-readable description of an unexpected value. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  return `${kind === "object" ? "an" : "a"} ${kind}`;
}
