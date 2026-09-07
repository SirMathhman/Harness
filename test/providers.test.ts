import { describe, expect, test } from "bun:test";
import { createSession } from "../src/agent/session.js";
import { runTurn } from "../src/agent/loop.js";
import { LlamaProvider, type Provider } from "../src/providers/index.js";
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

describe("the context window is learned at runtime (v0.9.0 spec §2, §3)", () => {
  /** A graph whose one discovered model comes from a provider under test. */
  function graphWith(provider: Partial<Provider> & { name: string }) {
    return withDiscovered(
      (reg) => {
        reg.addProvider({
          name: provider.name,
          async discoverModels() {
            return [];
          },
          ...provider,
        });
      },
      {
        [provider.name]: [
          { name: "m", baseUrl: "http://x", apiKey: "" },
        ] as ModelDef[],
      },
    );
  }

  test("a provider that reports no window still starts a session (the router case)", () => {
    // A llama.cpp router lists models it has never loaded, so discovery can
    // report no window at all. That used to be fatal at startup.
    const handle = createSession({
      graph: graphWith({ name: "llama" }),
      client: { async chat() { return finish("ok"); } },
    });
    expect(handle.session.config.model).toBe("m");
    expect(handle.session.contextWindow).toBe(null);
  });

  test("the window is learned from the provider after the first completion", async () => {
    const asked: string[] = [];
    const handle = createSession({
      graph: graphWith({
        name: "llama",
        async contextWindow(model: string) {
          asked.push(model);
          // Unloaded on the first ask, loaded by the second.
          return asked.length === 1 ? null : 32768;
        },
      }),
      client: { async chat() { return finish("ok"); } },
    });
    const client: LLMClient = { async chat() { return finish("ok"); } };

    await runTurn(handle.session, "one", handle.registry, {}, undefined, client);
    expect(asked).toEqual(["m"]);
    expect(handle.session.contextWindow).toBe(null);

    await runTurn(handle.session, "two", handle.registry, {}, undefined, client);
    expect(handle.session.contextWindow).toBe(32768);

    // Once known it is never re-asked.
    await runTurn(handle.session, "three", handle.registry, {}, undefined, client);
    expect(asked).toHaveLength(2);
  });

  test("a probe that throws leaves the window unknown, not the turn failed", async () => {
    const handle = createSession({
      graph: graphWith({
        name: "llama",
        async contextWindow() {
          throw new Error("boom");
        },
      }),
    });
    const client: LLMClient = { async chat() { return finish("ok"); } };
    const result = await runTurn(
      handle.session,
      "t",
      handle.registry,
      {},
      undefined,
      client,
    );
    expect(result.answer).toBe("ok");
    expect(handle.session.contextWindow).toBe(null);
  });

  test("a pinned setRuntime window wins and is never probed", async () => {
    let asked = 0;
    const graph = withDiscovered(
      (reg) => {
        reg.setRuntime({ contextWindow: 4096 });
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
          async contextWindow() {
            asked++;
            return 32768;
          },
        });
      },
      { llama: [{ name: "m", baseUrl: "http://x", apiKey: "" }] },
    );
    const handle = createSession({ graph });
    expect(handle.session.contextWindow).toBe(4096);
    await runTurn(
      handle.session,
      "t",
      handle.registry,
      {},
      undefined,
      { async chat() { return finish("ok"); } },
    );
    expect(handle.session.contextWindow).toBe(4096);
    expect(asked).toBe(0);
  });
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

  test("discovery reports only where a model lives, never its window", async () => {
    // Even when the server does report meta.n_ctx, discovery drops it: the
    // window belongs to the loaded model and is asked for separately.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          data: [{ id: "with-ctx", meta: { n_ctx: 88576 } }, { id: "no-ctx" }],
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const provider = new LlamaProvider({ url });
      expect(await provider.discoverModels()).toEqual([
        { name: "with-ctx", baseUrl: url, apiKey: "" },
        { name: "no-ctx", baseUrl: url, apiKey: "" },
      ]);
    } finally {
      server.stop();
    }
  });

  describe("contextWindow (v0.9.0 spec §2, §3)", () => {
    /** A stub llama.cpp exposing `/v1/models` and `/props`. */
    function serve(models: unknown, props: unknown) {
      return Bun.serve({
        port: 0,
        fetch(req) {
          const { pathname } = new URL(req.url);
          if (pathname === "/v1/models") return Response.json(models);
          if (pathname === "/props") return Response.json(props);
          return new Response("nope", { status: 404 });
        },
      });
    }

    test("reads meta.n_ctx of the loaded model", async () => {
      const server = serve(
        { data: [{ id: "a" }, { id: "b", meta: { n_ctx: 88576 } }] },
        { role: "router", default_generation_settings: { n_ctx: 0 } },
      );
      try {
        const url = `http://127.0.0.1:${server.port}`;
        expect(await new LlamaProvider({ url }).contextWindow("b")).toBe(88576);
      } finally {
        server.stop();
      }
    });

    test("falls back to /props on a plain single-model server", async () => {
      const server = serve(
        { data: [{ id: "a" }] },
        { default_generation_settings: { n_ctx: 4096 } },
      );
      try {
        const url = `http://127.0.0.1:${server.port}`;
        expect(await new LlamaProvider({ url }).contextWindow("a")).toBe(4096);
      } finally {
        server.stop();
      }
    });

    test("is null for a router model that is not loaded yet", async () => {
      // The exact shape a llama.cpp router serves before anything is loaded:
      // no `meta` on any entry, and a /props that describes the router.
      const server = serve(
        { data: [{ id: "a", status: { value: "unloaded" } }] },
        { role: "router", default_generation_settings: { n_ctx: 0 } },
      );
      try {
        const url = `http://127.0.0.1:${server.port}`;
        expect(await new LlamaProvider({ url }).contextWindow("a")).toBe(null);
      } finally {
        server.stop();
      }
    });

    test("is null for an unreachable server, never a throw", async () => {
      const provider = new LlamaProvider({ url: "http://127.0.0.1:1" });
      expect(await provider.contextWindow("a")).toBe(null);
    });
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
        openrouter: [
          { name: "c", baseUrl: "http://y", apiKey: "" },
        ],
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
      {
        llama: [
          { name: "a", baseUrl: "http://x", apiKey: "" },
        ],
      },
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
        llama_a: [
          { name: "shared", baseUrl: "http://a", apiKey: "" },
        ],
        llama_b: [
          { name: "shared", baseUrl: "http://b", apiKey: "" },
        ],
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
      {
        llama: [
          { name: "a", baseUrl: "http://a", apiKey: "" },
        ],
      },
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

describe("LlamaProvider.admitModel (v0.10.0 spec §3)", () => {
  /** A stub llama.cpp whose `/v1/models` and `/props` bodies can change. */
  function serveMutable(state: { models: unknown; props: unknown }) {
    const hits = { props: 0, models: 0 };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/v1/models") {
          hits.models++;
          return Response.json(state.models);
        }
        if (pathname === "/props") {
          hits.props++;
          return Response.json(state.props);
        }
        return new Response("nope", { status: 404 });
      },
    });
    return { server, hits, url: `http://127.0.0.1:${server.port}` };
  }

  const router = (max?: number) => ({
    role: "router",
    ...(max === undefined ? {} : { max_instances: max }),
  });
  /** `a` resident (with a size), `b` known to the router but not loaded. */
  const aLoaded = {
    data: [
      { id: "a", meta: { n_ctx: 4096, size: 1024 * 1024 * 100 } },
      { id: "b" },
    ],
  };

  test("admits a model when a slot is free", async () => {
    const { server, url } = serveMutable({ models: aLoaded, props: router(2) });
    try {
      const verdict = await new LlamaProvider({ url }).admitModel("b");
      expect(verdict).toEqual({ ok: true, loaded: ["a"] });
    } finally {
      server.stop();
    }
  });

  test("refuses when every slot is in use", async () => {
    const { server, url } = serveMutable({ models: aLoaded, props: router(1) });
    try {
      const verdict = await new LlamaProvider({ url }).admitModel("b");
      expect(verdict?.ok).toBe(false);
      expect(verdict?.loaded).toEqual(["a"]);
      expect(verdict?.reason).toBe("has no free model slot (1 of 1 in use)");
    } finally {
      server.stop();
    }
  });

  test("always admits a model that is already loaded", async () => {
    // Even with every slot in use: using what is resident evicts nothing.
    const { server, url } = serveMutable({ models: aLoaded, props: router(1) });
    try {
      const verdict = await new LlamaProvider({ url }).admitModel("a");
      expect(verdict).toEqual({ ok: true, loaded: ["a"] });
    } finally {
      server.stop();
    }
  });

  test("admits a model whose size is unknown", async () => {
    // `b` has never been resident, so no `meta.size` was ever reported for it
    // and there is nothing to weigh against free VRAM (spec §2.3).
    const { server, url } = serveMutable({ models: aLoaded, props: router(2) });
    try {
      const provider = new LlamaProvider({ url, freeVramMiB: () => 1 });
      expect((await provider.admitModel("b"))?.ok).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("refuses when the model is larger than free VRAM", async () => {
    // `b` is resident first, so its size is learned; then it is evicted and
    // asked about again — the case a real router actually produces.
    const state = {
      models: { data: [{ id: "b", meta: { size: 1024 * 1024 * 500 } }] },
      props: router(2),
    };
    const { server, url } = serveMutable(state);
    try {
      const provider = new LlamaProvider({ url, freeVramMiB: () => 200 });
      await provider.discoverModels();
      state.models = aLoaded;

      const verdict = await provider.admitModel("b");
      expect(verdict?.ok).toBe(false);
      expect(verdict?.reason).toBe(
        "does not have enough free VRAM (needs ~500 MiB, 200 MiB free)",
      );
    } finally {
      server.stop();
    }
  });

  test("a VRAM probe that throws leaves VRAM unchecked", async () => {
    const state = {
      models: { data: [{ id: "b", meta: { size: 1024 * 1024 * 500 } }] },
      props: router(2),
    };
    const { server, url } = serveMutable(state);
    try {
      const provider = new LlamaProvider({
        url,
        freeVramMiB: () => {
          throw new Error("no nvidia-smi here");
        },
      });
      await provider.discoverModels();
      state.models = aLoaded;
      expect((await provider.admitModel("b"))?.ok).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("does not check VRAM without a probe", async () => {
    const state = {
      models: { data: [{ id: "b", meta: { size: 1024 * 1024 * 500 } }] },
      props: router(2),
    };
    const { server, url } = serveMutable(state);
    try {
      const provider = new LlamaProvider({ url });
      await provider.discoverModels();
      state.models = aLoaded;
      expect((await provider.admitModel("b"))?.ok).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("refuses when a router will not report capacity", async () => {
    const { server, url } = serveMutable({
      models: aLoaded,
      props: router(undefined),
    });
    try {
      const verdict = await new LlamaProvider({ url }).admitModel("b");
      expect(verdict?.ok).toBe(false);
      expect(verdict?.reason).toBe(
        "does not report how many models it can hold at once",
      );
    } finally {
      server.stop();
    }
  });

  test("treats a plain server as a single slot", async () => {
    // No `role: "router"` and no `max_instances`: it holds exactly one model,
    // which is an answer of 1 rather than an unknown (spec §3.2).
    const { server, url } = serveMutable({
      models: aLoaded,
      props: { default_generation_settings: { n_ctx: 4096 } },
    });
    try {
      const verdict = await new LlamaProvider({ url }).admitModel("b");
      expect(verdict?.ok).toBe(false);
      expect(verdict?.reason).toBe("has no free model slot (1 of 1 in use)");
    } finally {
      server.stop();
    }
  });

  test("caches a positive slot count", async () => {
    const { server, hits, url } = serveMutable({
      models: aLoaded,
      props: router(2),
    });
    try {
      const provider = new LlamaProvider({ url });
      await provider.admitModel("b");
      await provider.admitModel("b");
      // `/props` is fixed by the server's command line; `/v1/models` is not.
      expect(hits.props).toBe(1);
      expect(hits.models).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("does not cache a failed slot-count read", async () => {
    const state: { models: unknown; props: unknown } = {
      models: aLoaded,
      props: router(undefined),
    };
    const { server, url } = serveMutable(state);
    try {
      const provider = new LlamaProvider({ url });
      expect((await provider.admitModel("b"))?.ok).toBe(false);
      state.props = router(2);
      expect((await provider.admitModel("b"))?.ok).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("reports null for an unreachable server, never throws", async () => {
    const provider = new LlamaProvider({ url: "http://127.0.0.1:1" });
    expect(await provider.admitModel("b")).toBeNull();
  });
});

describe("subagent capacity gate (v0.10.0 spec §3.4, E-P9)", () => {
  type Admit = NonNullable<Provider["admitModel"]>;

  /**
   * A parent on `a` and a "worker" profile whose whitelist selects `b`, both
   * discovered from one provider whose `admitModel` is scripted by `admit`.
   */
  function gateGraph(
    admit: Admit | undefined,
    calls: string[],
    whitelistPattern = "b",
  ): ResourceGraph {
    return withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
          ...(admit === undefined
            ? {}
            : {
                admitModel: (model: string) => {
                  calls.push(model);
                  return admit(model);
                },
              }),
        });
        reg.createProfile({
          name: "worker",
          systemPrompt: "w",
          models: [["llama", whitelistPattern]],
        });
      },
      {
        llama: [
          { name: "a", baseUrl: "http://a", apiKey: "" },
          { name: "b", baseUrl: "http://a", apiKey: "" },
        ],
      },
    );
  }

  const client: LLMClient = {
    async chat() {
      return finish("done");
    },
  };

  const spawn = (graph: ResourceGraph) =>
    createSession({ graph, client })
      .registry.get("spawn_subagent")!
      .handler({ task: "t", maxIterations: 3, profile: "worker" });

  test("fails the subagent when the backend refuses", async () => {
    const calls: string[] = [];
    const graph = gateGraph(
      async () => ({
        ok: false,
        reason: "has no free model slot (1 of 1 in use)",
        loaded: ["a"],
      }),
      calls,
    );
    const out = await spawn(graph);
    expect(calls).toEqual(["b"]);
    expect(out).toContain("subagent failed");
    expect(out).toContain('profile "worker"');
    expect(out).toContain('model "b"');
    expect(out).toContain("has no free model slot (1 of 1 in use)");
    expect(out).toContain("currently loaded: a");
    expect(out).toContain("a different provider");
  });

  test("runs the subagent when the backend admits", async () => {
    const calls: string[] = [];
    const graph = gateGraph(async () => ({ ok: true, loaded: ["a"] }), calls);
    expect(await spawn(graph)).toBe("done");
    expect(calls).toEqual(["b"]);
  });

  test("never asks about the parent's own model", async () => {
    // The whitelist re-selects `a`, which the parent already has resident.
    const calls: string[] = [];
    const graph = gateGraph(
      async () => ({ ok: false, reason: "should never be asked", loaded: [] }),
      calls,
      "a",
    );
    expect(await spawn(graph)).toBe("done");
    expect(calls).toEqual([]);
  });

  test("never gates a provider that cannot answer", async () => {
    expect(await spawn(gateGraph(undefined, []))).toBe("done");
  });

  test("an admitModel that cannot say allows the run", async () => {
    const calls: string[] = [];
    expect(await spawn(gateGraph(async () => null, calls))).toBe("done");
    expect(calls).toEqual(["b"]);
  });

  test("an admitModel that throws allows the run", async () => {
    const calls: string[] = [];
    const graph = gateGraph(async () => {
      throw new Error("contract broken");
    }, calls);
    expect(await spawn(graph)).toBe("done");
  });

  test("never gates a model on a different provider", async () => {
    // Two providers are two servers: loading on one evicts nothing on the other.
    const calls: string[] = [];
    const graph = withDiscovered(
      (reg) => {
        reg.addProvider({
          name: "llama",
          async discoverModels() {
            return [];
          },
          admitModel: async (model: string) => {
            calls.push(model);
            return { ok: false, reason: "should never be asked", loaded: [] };
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
      {
        llama: [{ name: "a", baseUrl: "http://a", apiKey: "" }],
        other: [{ name: "b", baseUrl: "http://b", apiKey: "" }],
      },
    );
    expect(await spawn(graph)).toBe("done");
    expect(calls).toEqual([]);
  });
});
