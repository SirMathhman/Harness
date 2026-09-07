import {
  buildGraphFrom,
  type ProfileDef,
  type Registry,
  type ResourceGraph,
  type ResourceId,
  type RuntimeSettings,
  type ViseConfig,
} from "../src/profiles/index.js";

/** Build a resource graph from an inline config function, as `.vise` would. */
export function graphFrom(setup: ViseConfig): ResourceGraph {
  return buildGraphFrom(setup, "<test config>");
}

/**
 * A graph whose default profile talks to `baseUrl` with a fixed model name, so
 * a test never depends on model auto-discovery.
 */
export function modelGraph(
  baseUrl = "http://localhost:8080",
  runtime: Partial<RuntimeSettings> = {},
  extra: (reg: Registry) => void = () => {},
): ResourceGraph {
  return graphFrom((reg) => {
    // Tests never talk to a real backend, so nothing can report a context
    // window; pin one so compaction has a threshold to work against.
    reg.setRuntime({ contextWindow: 8192, ...runtime });
    reg.createConnection(
      reg.builtins.defaultProfile,
      reg.createModel({ name: "test-model", baseUrl, apiKey: "" }),
    );
    extra(reg);
  });
}

/**
 * A graph of named profiles that all share one working model, so a test can
 * switch between them without tripping the "profile has no model" guard.
 *
 * `setup` receives the model id and a `profile(name, def)` helper that creates
 * a profile already connected to it.
 */
export function profileGraph(
  setup: (
    reg: Registry,
    profile: (name: string, def?: Partial<ProfileDef>) => ResourceId,
    model: ResourceId,
  ) => void,
): ResourceGraph {
  return graphFrom((reg) => {
    reg.setRuntime({ contextWindow: 8192 });
    const model = reg.createModel({
      name: "test-model",
      baseUrl: "http://localhost:8080",
      apiKey: "",
    });
    const profile = (name: string, def: Partial<ProfileDef> = {}) => {
      const id = reg.createProfile({ name, systemPrompt: "", ...def });
      reg.createConnection(id, model);
      return id;
    };
    setup(reg, profile, model);
  });
}
