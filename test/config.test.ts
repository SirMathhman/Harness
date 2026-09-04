import { describe, expect, test } from "bun:test";
import {
  resolveConfig,
  validateConfig,
  ConfigError,
  type CliFlags,
} from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Config } from "../src/types.js";

const emptyFlags: CliFlags = {};

describe("config resolution & precedence (AC 12)", () => {
  test("defaults are used when nothing else is set", () => {
    const env: NodeJS.ProcessEnv = { HARNESS_MODEL: "m" };
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(cfg.temperature).toBe(DEFAULT_CONFIG.temperature);
    expect(cfg.maxContext).toBe(DEFAULT_CONFIG.maxContext);
  });

  test("env overrides defaults", () => {
    const env: NodeJS.ProcessEnv = { HARNESS_MODEL: "env-model" };
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.model).toBe("env-model");
  });

  test("flags override env", () => {
    const env: NodeJS.ProcessEnv = { HARNESS_MODEL: "env-model" };
    const flags: CliFlags = { model: "flag-model" };
    const cfg = resolveConfig(flags, "./does-not-exist.json", env);
    expect(cfg.model).toBe("flag-model");
  });

  test("numeric env values are coerced", () => {
    const env: NodeJS.ProcessEnv = {
      HARNESS_MODEL: "m",
      HARNESS_TEMPERATURE: "0.7",
      HARNESS_MAX_CONTEXT: "4096",
    };
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxContext).toBe(4096);
  });

  test("boolean env value is coerced", () => {
    const env: NodeJS.ProcessEnv = {
      HARNESS_MODEL: "m",
      HARNESS_PARALLEL_TOOLS: "false",
    };
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.parallelToolCalls).toBe(false);
  });

  test("a null model is allowed by resolveConfig (discovery happens in index.ts)", () => {
    const env: NodeJS.ProcessEnv = {};
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.model).toBeNull();
  });

  test("validateConfig rejects negative temperature", () => {
    const cfg: Config = { ...DEFAULT_CONFIG, model: "m", temperature: -1 };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
  });

  test("validateConfig rejects non-positive maxContext", () => {
    const cfg: Config = { ...DEFAULT_CONFIG, model: "m", maxContext: 0 };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
  });

  test("validateConfig allows a null model (discovery happens later)", () => {
    const cfg: Config = { ...DEFAULT_CONFIG, model: null };
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});
