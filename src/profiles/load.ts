import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultGraph, ViseRegistry, type ResourceGraph } from "./registry.js";
import { validateGraph, ViseConfigError } from "./validate.js";
import type { ViseConfig } from "./types.js";

/** The config directory Vise looks in, relative to the project root. */
export const CONFIG_DIR = ".vise";

/**
 * Entry points tried in order (profiles spec §3.1). `.ts` is the documented
 * one; `.js` is accepted so a config can be pre-compiled for runtimes without
 * TypeScript support.
 */
export const CONFIG_ENTRIES = ["index.ts", "index.js", "index.mjs"] as const;

/**
 * The absolute path of the config entry point under `root`, or null when the
 * project has no `.vise/` config at all.
 */
export function findConfigEntry(root: string = process.cwd()): string | null {
  for (const entry of CONFIG_ENTRIES) {
    const candidate = path.join(root, CONFIG_DIR, entry);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load `./.vise/index.ts` and build the session's resource graph
 * (profiles spec §3.10).
 *
 * With no config file the built-in defaults apply (§3.8): the implicit
 * profile, the default model, every built-in tool, and no hooks. Any other
 * failure — an import error, a missing or non-function default export, a throw
 * from the config function, an invalid graph — is fatal and raises a
 * `ViseConfigError` describing the problem.
 */
export async function loadViseConfig(
  root: string = process.cwd(),
): Promise<ResourceGraph> {
  const entry = findConfigEntry(root);
  if (entry === null) return defaultGraph();
  return buildGraphFrom(await importConfig(entry), entry);
}

/**
 * Run a config function against a fresh registry and validate the result.
 * Exported so tests (and composable configs) can build a graph without a file.
 *
 * `source` names the config in error messages.
 */
export function buildGraphFrom(
  config: ViseConfig,
  source = "<inline config>",
): ResourceGraph {
  const registry = new ViseRegistry();
  try {
    config(registry);
  } catch (err) {
    throw new ViseConfigError(
      `${source} threw while building the configuration: ` +
        `${(err as Error).message}`,
    );
  }
  return validateGraph(registry.build());
}

/** Dynamically import a config entry and return its validated default export. */
async function importConfig(entry: string): Promise<ViseConfig> {
  let module: { default?: unknown };
  try {
    // A cache-busting query keeps repeated loads (tests, future reloads) from
    // returning a stale module for the same path.
    module = (await import(
      `${pathToFileURL(entry).href}?t=${Date.now()}`
    )) as { default?: unknown };
  } catch (err) {
    throw new ViseConfigError(
      `Failed to load ${entry}: ${(err as Error).message}`,
    );
  }

  const exported = module.default;
  if (exported === undefined) {
    throw new ViseConfigError(
      `${entry} has no default export. It must default-export a function ` +
        `of type (reg: Registry) => void.`,
    );
  }
  if (typeof exported !== "function") {
    throw new ViseConfigError(
      `The default export of ${entry} must be a function of type ` +
        `(reg: Registry) => void (got ${describe(exported)}).`,
    );
  }
  return exported as ViseConfig;
}

/** A short, human-readable description of an unexpected value. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  return `${kind === "object" ? "an" : "a"} ${kind}`;
}
