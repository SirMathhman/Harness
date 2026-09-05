import { describe, expect, test } from "bun:test";
import { createSession } from "../src/agent/session.js";
import { LlamaProvider } from "../src/providers/index.js";
import type { Config, LLMClient } from "../src/llm/client.js";
import {
  AmbiguousModelError,
  addDiscoveredModels,
  IMPLICIT_PROFILE_NAME,
  ModelNotAvailableError,
  resolveProfile,
  ViseRegistry,
  type DiscoveryResult,
  type ModelDef,
  type Registry,
  type ResourceGraph,
} from "../src/profiles/index.js";
import { graphFrom } from "./helpers.js";

/**
 * Build a graph, then simulate startup discovery: `discovered` maps a
 * registered provider's name to the `ModelDef[]` it "returned".
 */
function withDiscovered(
  setup: (reg: Registry) => void,
  discovered: Record<string, ModelDef[]>,
): ResourceGraph {
  const graph = graphFrom(setup);
  const results: DiscoveryResult[] = [];
  for (const [name, models] of Object.entries(discovered)) {
    const providerId = graph.providerNames.get(name);
    if (providerId === undefined) {
      throw new Error(`test setup: provider "${name}" was never registered`);
    }
    results.push({ providerId, models });
  }
  return addDiscoveredModels(graph, results);
}

const finish = (answer: string): Awaited<ReturnType<LLMClient["chat"]>> => ({
  content: "",
  toolCalls: [{ id: "f1", name: "finish", arguments: { answer } }],
  usage: null,
});

describe("LlamaProvider (providers spec §3.2)", () => {
  test("discovers every model from GET /v1/models, including router mode", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ id: "a" }, { id: "b" }] });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const provider = new LlamaProvider({ url });
      expect(await provider.discoverModels()).toEqual([
        { name: "a", baseUrl: url, apiKey: "" },
        { name: "b", baseUrl: url, apiKey: "" },
      ]);
    } finally {
      server.stop();
    }
  });

  test("returns [] when the server is unreachable (E-P1)", async () => {
    const provider = new LlamaProvider({ url: "http://127.0.0.1:1" });
    expect(await provider.discoverModels()).toEqual([]);
  });

  test("returns [] on a non-OK HTTP response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const provider = new LlamaProvider({
        url: `http://127.0.0.1:${server.port}`,
      });
      expect(await provider.discoverModels()).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("returns [] on a malformed response body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not json", { status: 200 });
      },
    });
    try {
      const provider = new LlamaProvider({
        url: `http://127.0.0.1:${server.port}`,
      });
      expect(await provider.discoverModels()).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("returns [] when the server reports an empty model list", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [] });
      },
    });
    try {
      const provider = new LlamaProvider({
        url: `http://127.0.0.1:${server.port}`,
      });
      expect(await provider.discoverModels()).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("sends the api key as a Bearer token", async () => {
    let seenAuth: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seenAuth = req.headers.get("authorization");
        return Response.json({ data: [{ id: "a" }] });
      },
    });
    try {
      const provider = new LlamaProvider({
        url: `http://127.0.0.1:${server.port}`,
        apiKey: "secret",
      });
      await provider.discoverModels();
      expect(seenAuth).toBe("Bearer secret");
    } finally {
      server.stop();
    }
  });
});

describe("Registry.addProvider / getProvider (providers spec §3.3)", () => {
  test("an explicit name is kept as-is", () => {
    const reg = new ViseRegistry();
    const id = reg.addProvider({
      name: "custom",
      async discoverModels() {
        return [];
      },
    });
    expect(reg.getProvider("custom")).toBe(id);
    expect(reg.builtins.providers.custom).toBe(id);
  });

  test("an omitted name is auto-generated from the class name, per-class counted (§3.2)", () => {
    const reg = new ViseRegistry();
    const a = new LlamaProvider({ url: "http://localhost:8080" });
    const b = new LlamaProvider({ url: "http://localhost:8081" });
    reg.addProvider(a);
    reg.addProvider(b);
    expect(a.name).toBe("llama_0");
    expect(b.name).toBe("llama_1");
  });

  test("a duplicate provider name is fatal (E-P2)", () => {
    const reg = new ViseRegistry();
    reg.addProvider({
      name: "dup",
      async discoverModels() {
        return [];
      },
    });
    expect(() =>
      reg.addProvider({
        name: "dup",
        async discoverModels() {
          return [];
        },
      }),
    ).toThrow(/Duplicate provider name "dup"/);
  });

  test("a plain object literal satisfies Provider without any concrete class (P7)", () => {
    const graph = graphFrom((reg) => {
      reg.addProvider({
        name: "mock",
        async discoverModels() {
          return [{ name: "m", baseUrl: "http://x", apiKey: "" }];
        },
      });
    });
    expect(graph.providerNames.has("mock")).toBe(true);
  });
});

describe("startup discovery → Model resources (providers spec §3.6)", () => {
  test("no provider registered leaves the graph with zero models", () => {
    const graph = graphFrom(() => {});
    expect(graph.providers.size).toBe(0);
  });

  test("addDiscoveredModels creates one Model per returned ModelDef, tagged with its provider", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://x", apiKey: "" },
          { name: "b", baseUrl: "http://x", apiKey: "" },
        ],
      },
    );
    const providerId = graph.providerNames.get("llama");
    const models = [...graph.resources.values()].filter(
      (r) => r.kind === "model",
    );
    expect(models).toHaveLength(2);
    for (const m of models) {
      if (m.kind === "model") {
        expect(m.def.provider).toBe(providerId!);
        expect(m.discovered).toBe(true);
      }
    }
  });
});

describe("profile model-selection whitelist (providers spec §3.4)", () => {
  test("a missing models field sees every discovered model; the first wins by default", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://x", apiKey: "" },
          { name: "b", baseUrl: "http://x", apiKey: "" },
        ],
      },
    );
    const resolved = resolveProfile(graph, IMPLICIT_PROFILE_NAME);
    expect(resolved.config.model).toBe("a");
    expect(resolved.availableModelIds).toHaveLength(2);
  });

  test("lastModel pins the active model when it is in the available set (§3.9)", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://x", apiKey: "" },
          { name: "b", baseUrl: "http://x", apiKey: "" },
        ],
      },
    );
    expect(
      resolveProfile(graph, IMPLICIT_PROFILE_NAME, { modelNameHint: "b" })
        .config.model,
    ).toBe("b");
    // An unrecognized hint falls back to the first model, not an error.
    expect(
      resolveProfile(graph, IMPLICIT_PROFILE_NAME, { modelNameHint: "ghost" })
        .config.model,
    ).toBe("a");
  });

  test("a string element includes every model from that provider", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.addProvider({
          name: "openrouter",
          async discoverModels() {
            return [];
          },
        });
        reg.createProfile({ name: "p", systemPrompt: "", models: ["llama"] });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://x", apiKey: "" },
          { name: "b", baseUrl: "http://x", apiKey: "" },
        ],
        openrouter: [{ name: "c", baseUrl: "http://y", apiKey: "" }],
      },
    );
    const resolved = resolveProfile(graph, "p");
    expect(resolved.availableModelIds).toHaveLength(2);
    expect(resolved.config.model).toBe("a");
  });

  test("a [provider, regex] element filters by model name, full-string match", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.createProfile({
          name: "p",
          systemPrompt: "",
          models: [["llama", "^qwen.*$"]],
        });
      },
      {
        llama: [
          { name: "qwen-7b", baseUrl: "http://x", apiKey: "" },
          { name: "llama-3", baseUrl: "http://x", apiKey: "" },
        ],
      },
    );
    const resolved = resolveProfile(graph, "p");
    expect(resolved.availableModelIds).toHaveLength(1);
    expect(resolved.config.model).toBe("qwen-7b");
  });

  test("an explicit reg.createModel() model (no provider) never matches a non-empty whitelist", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.createModel({ name: "manual", baseUrl: "http://z", apiKey: "" });
        reg.createProfile({ name: "p", systemPrompt: "", models: ["llama"] });
      },
      { llama: [{ name: "a", baseUrl: "http://x", apiKey: "" }] },
    );
    const resolved = resolveProfile(graph, "p");
    expect(resolved.availableModelIds).toHaveLength(1);
    expect(resolved.config.model).toBe("a");
  });

  test("an unknown provider in a whitelist is a fatal config error (E-P3)", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.createProfile({ name: "p", systemPrompt: "", models: ["ghost"] });
      }),
    ).toThrow(/references unknown provider "ghost"/);
  });

  test("a Profile→Model connection outside a non-empty whitelist is fatal (E-P5)", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        const model = reg.createModel({
          name: "manual",
          baseUrl: "http://z",
          apiKey: "",
        });
        const p = reg.createProfile({
          name: "p",
          systemPrompt: "",
          models: ["llama"],
        });
        reg.createConnection(p, model);
      }),
    ).toThrow(
      /is connected to model "manual" which is not in its models whitelist/,
    );
  });
});

describe("/model across providers (providers spec §3.8)", () => {
  test("two providers serving the same model name require disambiguation (E-P6)", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama_a",
          async discoverModels() {
            return [];
          },
        });
        reg.addProvider({
          name: "llama_b",
          async discoverModels() {
            return [];
          },
        });
      },
      {
        llama_a: [{ name: "shared", baseUrl: "http://a", apiKey: "" }],
        llama_b: [{ name: "shared", baseUrl: "http://b", apiKey: "" }],
      },
    );
    const handle = createSession({ graph });
    expect(() => handle.switchModel("shared")).toThrow(AmbiguousModelError);
    handle.switchModel("llama_b/shared");
    expect(handle.session.config.baseUrl).toBe("http://b");
  });

  test("a model name containing a slash is matched exactly before the provider split", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
      },
      {
        llama: [
          {
            name: "peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF:Q4_K_XL",
            baseUrl: "http://x",
            apiKey: "",
          },
        ],
      },
    );
    const handle = createSession({ graph });
    handle.switchModel("peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF:Q4_K_XL");
    expect(handle.session.config.model).toBe(
      "peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF:Q4_K_XL",
    );
    expect(handle.session.config.baseUrl).toBe("http://x");
  });

  test("switching outside the active profile's whitelist is rejected (E-P7)", () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.createProfile({
          name: "p",
          systemPrompt: "",
          models: [["llama", "^a$"]],
        });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://x", apiKey: "" },
          { name: "b", baseUrl: "http://x", apiKey: "" },
        ],
      },
    );
    const handle = createSession({ graph, profile: "p" });
    expect(() => handle.switchModel("b")).toThrow(ModelNotAvailableError);
  });
});

describe("subagent model inheritance (providers spec §3.7)", () => {
  test("a subagent profile with no models whitelist inherits the parent's exact active model", async () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.createProfile({ name: "worker", systemPrompt: "w" });
      },
      {
        llama: [
          {
            name: "a",
            baseUrl: "http://a",
            apiKey: "k1",
            temperature: 0.3,
            maxContext: 4096,
          },
        ],
      },
    );
    const seenConfigs: Config[] = [];
    const client: LLMClient = {
      async chat(opts) {
        seenConfigs.push(opts.config);
        return finish("done");
      },
    };
    const handle = createSession({ graph, client });
    const tool = handle.registry.get("spawn_subagent")!;
    const out = await tool.handler({
      task: "t",
      maxIterations: 3,
      profile: "worker",
    });
    expect(out).toBe("done");
    expect(seenConfigs[0].baseUrl).toBe("http://a");
    expect(seenConfigs[0].model).toBe("a");
    expect(seenConfigs[0].apiKey).toBe("k1");
    expect(seenConfigs[0].temperature).toBe(0.3);
    expect(seenConfigs[0].maxContext).toBe(4096);
  });

  test("a non-empty whitelist matching no models falls back to the parent's model, with a warning (E-P8)", async () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.addProvider({
          name: "other",
          async discoverModels() {
            return [];
          },
        });
        reg.createProfile({
          name: "worker",
          systemPrompt: "w",
          models: ["other"],
        });
      },
      { llama: [{ name: "a", baseUrl: "http://a", apiKey: "" }] },
    );
    const logs: string[] = [];
    const client: LLMClient = {
      async chat() {
        return finish("done");
      },
    };
    const handle = createSession({ graph, client, log: (m) => logs.push(m) });
    const tool = handle.registry.get("spawn_subagent")!;
    const out = await tool.handler({
      task: "t",
      maxIterations: 3,
      profile: "worker",
    });
    expect(out).toBe("done");
    expect(logs.some((m) => m.includes("matches no models"))).toBe(true);
  });

  test("a non-empty whitelist that does match picks its first model, not the parent's", async () => {
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
        });
        reg.createProfile({
          name: "worker",
          systemPrompt: "w",
          models: [["llama", "^b$"]],
        });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://a", apiKey: "" },
          { name: "b", baseUrl: "http://b", apiKey: "" },
        ],
      },
    );
    const seenConfigs: Config[] = [];
    const client: LLMClient = {
      async chat(opts) {
        seenConfigs.push(opts.config);
        return finish("done");
      },
    };
    const handle = createSession({ graph, client });
    const tool = handle.registry.get("spawn_subagent")!;
    await tool.handler({ task: "t", maxIterations: 3, profile: "worker" });
    expect(seenConfigs[0].model).toBe("b");
    expect(seenConfigs[0].baseUrl).toBe("http://b");
  });
});
