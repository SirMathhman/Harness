import { describe, expect, test } from "bun:test";
import {
  resolveConfig,
  validateConfig,
  ConfigError,
  ModelNotConfiguredError,
  type CliFlags,
} from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Config } from "../src/types.js";

const emptyFlags: CliFlags = {};

describe("config resolution & precedence (AC 12)", () => {
  test("defaults are used when nothing else is set", async () => {
    const env: NodeJS.ProcessEnv = { HARNESS_MODEL: "m" };
    const cfg = await resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(cfg.temperature).toBe(DEFAULT_CONFIG.temperature);
    expect(cfg.maxContext).toBe(DEFAULT_CONFIG.maxContext);
  });

  test("env overrides defaults", async () => {
    const env: NodeJS.ProcessEnv = { HARNESS_MODEL: "env-model" };
    const cfg = await resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.model).toBe("env-model");
  });

  test("flags override env", async () => {
    const env: NodeJS.ProcessEnv = { HARNESS_MODEL: "env-model" };
    const flags: CliFlags = { model: "flag-model" };
    const cfg = await resolveConfig(flags, "./does-not-exist.json", env);
    expect(cfg.model).toBe("flag-model");
  });

  test("numeric env values are coerced", async () => {
    const env: NodeJS.ProcessEnv = {
      HARNESS_MODEL: "m",
      HARNESS_TEMPERATURE: "0.7",
      HARNESS_MAX_CONTEXT: "4096",
    };
    const cfg = await resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxContext).toBe(4096);
  });

  test("boolean env value is coerced", async () => {
    const env: NodeJS.ProcessEnv = {
      HARNESS_MODEL: "m",
      HARNESS_PARALLEL_TOOLS: "false",
    };
    const cfg = await resolveConfig(emptyFlags, "./does-not-exist.json", env);
    expect(cfg.parallelToolCalls).toBe(false);
  });

  test("missing model with no reachable server throws ModelNotConfiguredError (E16)", async () => {
    // Point at a port nothing is listening on so discovery fails.
    const env: NodeJS.ProcessEnv = { HARNESS_BASE_URL: "http://127.0.0.1:1" };
    await expect(
      resolveConfig(emptyFlags, "./does-not-exist.json", env),
    ).rejects.toThrow(ModelNotConfiguredError);
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

describe("model auto-discovery (spec §6.1)", () => {
  test("uses the first model reported by GET /v1/models when none is configured", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          object: "list",
          data: [{ id: "qwen2.5-coder-7b" }, { id: "other-model" }],
        });
      },
    });
    try {
      const env: NodeJS.ProcessEnv = {
        HARNESS_BASE_URL: `http://127.0.0.1:${server.port}`,
      };
      const cfg = await resolveConfig(emptyFlags, "./does-not-exist.json", env);
      expect(cfg.model).toBe("qwen2.5-coder-7b");
    } finally {
      server.stop();
    }
  });

  test("an explicitly configured model is not overridden by discovery", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          object: "list",
          data: [{ id: "discovered-model" }],
        });
      },
    });
    try {
      const env: NodeJS.ProcessEnv = {
        HARNESS_BASE_URL: `http://127.0.0.1:${server.port}`,
        HARNESS_MODEL: "explicit-model",
      };
      const cfg = await resolveConfig(emptyFlags, "./does-not-exist.json", env);
      expect(cfg.model).toBe("explicit-model");
    } finally {
      server.stop();
    }
  });

  test("a server reporting no models falls through to ModelNotConfiguredError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ object: "list", data: [] });
      },
    });
    try {
      const env: NodeJS.ProcessEnv = {
        HARNESS_BASE_URL: `http://127.0.0.1:${server.port}`,
      };
      await expect(
        resolveConfig(emptyFlags, "./does-not-exist.json", env),
      ).rejects.toThrow(ModelNotConfiguredError);
    } finally {
      server.stop();
    }
  });
});
