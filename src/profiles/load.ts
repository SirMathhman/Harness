import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
 * Load `~/.vise/index.ts` and `./.vise/index.ts` into one combined resource
 * graph (config spec §3.2, §3.10).
 *
 * The global file, if present, is loaded **first** into a fresh `Registry` so
 * the project file can look up its resources by name (§3.4); the project
 * file, if present, is loaded second into the same registry. With neither
 * file the built-in defaults apply (§3.8): the implicit profile, the default
 * model, every built-in tool, and no hooks.
 *
 * Any failure — an import error, a missing or non-function default export, a
 * throw from a config function, an invalid combined graph (including a
 * global/project name conflict, §3.3) — is fatal and raises a
 * `ViseConfigError` describing the problem.
 *
 * `globalRoot` overrides where the global file is looked for; it exists so
 * tests can point it at an isolated temp directory instead of the real home
 * directory.
 */
export async function loadViseConfig(
  root: string = process.cwd(),
  globalRoot: string = homedir(),
): Promise<ResourceGraph> {
  const registry = new ViseRegistry();

  const globalEntry = findConfigEntry(globalRoot);
  if (globalEntry !== null) {
    registry.setOrigin("global");
    // The global config is loaded with CWD set to its own directory so that
    // relative paths in the config (e.g. `fs.readdirSync("./agents")`) resolve
    // against the global config directory, not the project directory. The
    // original CWD is restored before the project config is loaded.
    const globalDir = path.dirname(globalEntry);
    const prevCwd = process.cwd();
    process.chdir(globalDir);
    try {
      runConfigFn(
        await importConfig(globalEntry, "~/.vise/index.ts"),
        registry,
        "~/.vise/index.ts",
      );
    } finally {
      process.chdir(prevCwd);
    }
  }

  const projectEntry = findConfigEntry(root);
  if (projectEntry !== null) {
    registry.setOrigin("project");
    runConfigFn(
      await importConfig(projectEntry, "./.vise/index.ts"),
      registry,
      "./.vise/index.ts",
    );
  }

  if (globalEntry === null && projectEntry === null) return defaultGraph();
  return validateGraph(registry.build());
}

/**
 * Run a config function against a fresh registry and validate the result.
 * Exported so tests (and composable configs) can build a graph without a
 * file. Always tags the created resources with origin `"project"` — the
 * single-file behavior every test in the suite relies on.
 *
 * `source` names the config in error messages.
 */
export function buildGraphFrom(
  config: ViseConfig,
  source = "<inline config>",
): ResourceGraph {
  const registry = new ViseRegistry();
  runConfigFn(config, registry, source);
  return validateGraph(registry.build());
}

/** Call a config function against `registry`, wrapping a throw as fatal. */
function runConfigFn(
  config: ViseConfig,
  registry: ViseRegistry,
  source: string,
): void {
  try {
    config(registry);
  } catch (err) {
    throw new ViseConfigError(
      `${source} threw while building the configuration: ` +
        `${(err as Error).message}`,
    );
  }
}

/**
 * Dynamically import a config entry and return its validated default export.
 * `displayName` is the path used in error messages (e.g. `~/.vise/index.ts`),
 * which may differ from `entry` (the real, resolved path actually imported).
 */
async function importConfig(
  entry: string,
  displayName: string,
): Promise<ViseConfig> {
  let module: { default?: unknown };
  try {
    // A cache-busting query keeps repeated loads (tests, future reloads) from
    // returning a stale module for the same path.
    module = (await import(`${pathToFileURL(entry).href}?t=${Date.now()}`)) as {
      default?: unknown;
    };
  } catch (err) {
    throw new ViseConfigError(
      `Failed to load ${displayName}: ${(err as Error).message}`,
    );
  }

  const exported = module.default;
  if (exported === undefined) {
    throw new ViseConfigError(
      `${displayName} has no default export. It must default-export a ` +
        `function of type (reg: Registry) => void.`,
    );
  }
  if (typeof exported !== "function") {
    throw new ViseConfigError(
      `The default export of ${displayName} must be a function of type ` +
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

/**
 * The stub written by `/init` and `/init-global`: a minimal, valid config
 * module that default-exports the required `(reg: Registry) => void` function.
 * It is intentionally empty of resources so the user starts from a known-good
 * baseline and adds models, profiles, hooks, and tools as needed.
 */
export const CONFIG_STUB = `import type { Registry } from "vise";

export default (reg: Registry) => {
  // Add your configuration here. See the README for the Registry API.
};
`;

/**
 * Write a config stub to `root/.vise/index.ts` (config spec §3.1).
 *
 * Creates the `.vise/` directory if it is missing and writes the stub. If a
 * config entry already exists under `root` (any of `CONFIG_ENTRIES`), the file
 * is left untouched and `false` is returned so the caller can report that
 * nothing was written. Returns `true` when the stub was written.
 *
 * `root` is the directory the config is created under: the project root for
 * `/init`, or the home directory for `/init-global`.
 */
export function writeConfigStub(root: string): boolean {
  if (findConfigEntry(root) !== null) return false;
  const dir = path.join(root, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.ts"), CONFIG_STUB, "utf8");
  return true;
}
