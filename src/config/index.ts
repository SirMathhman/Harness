import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Config } from "../types.js";
import { CONFIG_KEYS, DEFAULT_CONFIG, ENV_KEYS } from "./defaults.js";

/** Errors thrown for invalid configuration (E17). */
export class ConfigError extends Error {}

/** CLI flags accepted by the harness. */
export interface CliFlags {
  config?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxContext?: number;
  maxIterations?: number;
  help?: boolean;
}

/**
 * Parse CLI arguments using node:util parseArgs.
 * Unknown flags are ignored (the harness is a thin CLI).
 */
export function parseCliArgs(argv: string[]): {
  flags: CliFlags;
  positionals: string[];
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      temperature: { type: "string" },
      "max-context": { type: "string" },
      "max-iterations": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const flags: CliFlags = {
    config: values.config,
    model: values.model,
    baseUrl: values["base-url"],
    temperature: values.temperature ? Number(values.temperature) : undefined,
    maxContext: values["max-context"]
      ? Number(values["max-context"])
      : undefined,
    maxIterations: values["max-iterations"]
      ? Number(values["max-iterations"])
      : undefined,
    help: values.help,
  };
  return { flags, positionals };
}

/**
 * Load and parse the JSON config file at `path`.
 * Returns the parsed object, or null if the file does not exist.
 * Throws ConfigError (E17) if the file exists but is invalid JSON or has
 * unknown keys.
 */
export function loadConfigFile(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(
      `Cannot read config file at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid JSON in config file ${path}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${path} must contain a JSON object.`);
  }

  const obj = parsed as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(
    (k) => !CONFIG_KEYS.includes(k as keyof Config),
  );
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown key(s) in config file ${path}: ${unknown.join(", ")}. ` +
        `Valid keys: ${CONFIG_KEYS.join(", ")}.`,
    );
  }
  return obj;
}

/**
 * Coerce a raw env-var string into the typed value for a config key.
 * Returns undefined when the variable is unset.
 */
function envValue(key: keyof Config, env: NodeJS.ProcessEnv): unknown {
  const name = ENV_KEYS[key];
  const raw = env[name];
  if (raw === undefined) return undefined;
  switch (key) {
    case "temperature":
    case "maxContext":
    case "compactThreshold":
    case "compactKeepMessages":
    case "commandTimeoutMs":
    case "maxToolOutputChars":
      return Number(raw);
    case "parallelToolCalls":
    case "dynamicTools":
      return raw === "true" || raw === "1";
    case "maxIterations":
      return raw === "" || raw === "null" ? null : Number(raw);
    default:
      return raw;
  }
}

/**
 * Resolve the final Config from defaults, config file, env vars, and CLI flags.
 * Precedence: flags > env > file > defaults (spec §6.1).
 *
 * This is a pure, synchronous resolution: it does not touch the network. The
 * returned Config may have `model === null`; the composition root (index.ts)
 * is responsible for auto-discovering a model from the running server when
 * that is the case (spec §6.1: model is optional when a server is running).
 *
 * @param flags parsed CLI flags
 * @param configPath path to the config file (default ./harness.config.json)
 * @param env environment to read from (defaults to process.env)
 */
export function resolveConfig(
  flags: CliFlags,
  configPath = "./harness.config.json",
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const file = loadConfigFile(configPath) ?? {};

  // Start from defaults, layer file, then env, then flags.
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const key of CONFIG_KEYS) {
    if (file[key] !== undefined) merged[key] = file[key];
    const ev = envValue(key, env);
    if (ev !== undefined) merged[key] = ev;
  }

  // CLI flags override everything.
  if (flags.baseUrl !== undefined) merged.baseUrl = flags.baseUrl;
  if (flags.model !== undefined) merged.model = flags.model;
  if (flags.temperature !== undefined) merged.temperature = flags.temperature;
  if (flags.maxContext !== undefined) merged.maxContext = flags.maxContext;
  if (flags.maxIterations !== undefined)
    merged.maxIterations = flags.maxIterations;

  return validateConfig(merged as unknown as Config);
}

/**
 * Validate a resolved config: check types/ranges and required fields.
 * Throws ConfigError (E16/E17) on problems.
 */
export function validateConfig(cfg: Config): Config {
  const errors: string[] = [];

  if (typeof cfg.baseUrl !== "string" || cfg.baseUrl.length === 0) {
    errors.push("baseUrl must be a non-empty string.");
  }
  if (
    cfg.model !== null &&
    (typeof cfg.model !== "string" || cfg.model.length === 0)
  ) {
    errors.push("model must be a non-empty string or null.");
  }
  if (typeof cfg.apiKey !== "string") errors.push("apiKey must be a string.");

  const numeric: (keyof Config)[] = [
    "temperature",
    "maxContext",
    "compactThreshold",
    "compactKeepMessages",
    "commandTimeoutMs",
    "maxToolOutputChars",
  ];
  for (const key of numeric) {
    const v = cfg[key];
    if (typeof v !== "number" || Number.isNaN(v)) {
      errors.push(`${key} must be a number (got ${String(v)}).`);
    }
  }
  if (typeof cfg.maxContext === "number" && cfg.maxContext <= 0) {
    errors.push("maxContext must be > 0.");
  }
  if (typeof cfg.temperature === "number" && cfg.temperature < 0) {
    errors.push("temperature must be >= 0.");
  }
  if (
    typeof cfg.compactThreshold === "number" &&
    (cfg.compactThreshold <= 0 || cfg.compactThreshold > 1)
  ) {
    errors.push("compactThreshold must be in (0, 1].");
  }
  if (
    typeof cfg.compactKeepMessages === "number" &&
    cfg.compactKeepMessages < 0
  ) {
    errors.push("compactKeepMessages must be >= 0.");
  }
  if (
    typeof cfg.maxToolOutputChars === "number" &&
    cfg.maxToolOutputChars <= 0
  ) {
    errors.push("maxToolOutputChars must be > 0.");
  }

  if (typeof cfg.parallelToolCalls !== "boolean") {
    errors.push("parallelToolCalls must be a boolean.");
  }
  if (typeof cfg.dynamicTools !== "boolean") {
    errors.push("dynamicTools must be a boolean.");
  }
  if (typeof cfg.shell !== "string") errors.push("shell must be a string.");
  if (cfg.systemPrompt !== null && typeof cfg.systemPrompt !== "string") {
    errors.push("systemPrompt must be a string or null.");
  }
  if (
    cfg.maxIterations !== null &&
    (typeof cfg.maxIterations !== "number" || cfg.maxIterations < 1)
  ) {
    errors.push("maxIterations must be a positive integer or null.");
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Invalid configuration:\n  - ${errors.join("\n  - ")}`,
    );
  }

  // Note: a null model is allowed here. The composition root (index.ts)
  // auto-discovers one from the running server and prints a setup hint (E16)
  // only if discovery also fails.
  return cfg;
}
