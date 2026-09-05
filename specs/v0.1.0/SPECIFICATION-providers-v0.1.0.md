# System Specification: Providers & Model Discovery

**Version:** 0.1.0
**Date:** 2026-09-04
**Builds on:** `SPECIFICATION-config-v0.1.0.md` (two-tier config, profile persistence)

**Changes from the config spec (v0.1.0):**

- Introduced a **Provider** abstraction: a config-time convention (not a graph
  node kind) that the harness uses to discover available models at startup.
- Added `reg.addProvider(provider)` and `reg.getProvider(name)` to the
  `Registry` API. The registry gains a `providers` side-channel.
- Added a `provider` field to `ModelDef` (the provider's id) so the harness
  can disambiguate models that share a name across providers.
- Added a `models` whitelist field to `ProfileDef`, controlling which models
  are available to a profile and which is active by default.
- **Removed the built-in default model.** A profile with no usable model is
  fatal at startup or on `/profile` switch.
- **Removed llama.cpp as the implicit default.** With no provider registered,
  Vise exits with a fatal error.
- Model auto-discovery now happens at **startup** (after the config runs),
  querying each registered provider's `/v1/models` endpoint. Router mode
  (one URL, many models) is supported: one provider can yield N models.
- Subagents with an empty model spec **inherit the parent's active model**.

---

## 1. Purpose and Scope

### 1.1 Purpose

Decouple Vise from llama.cpp as the implicit default LLM backend by
introducing a **Provider** abstraction:

- A **Provider** is a TypeScript class (a config-time convention, not a graph
  node kind) that knows how to discover the models available from a given
  backend. The user registers providers in `.vise/index.ts` via
  `reg.addProvider(provider)`.
- At **startup**, the harness queries each registered provider's
  `/v1/models` endpoint and creates a `Model` resource for every discovered
  model. Each model carries a `provider` field (the provider's id) so the
  harness can disambiguate models that share a name across providers.
- A **profile** declares a `models` whitelist controlling which models are
  available to it and which is active by default. Subagents with an empty
  model spec inherit the parent's active model.
- The **built-in default model is removed.** With no provider registered, or
  with a profile that resolves to no usable model, Vise exits with a fatal
  error. There is no silent fallback to a hardcoded llama.cpp endpoint.

### 1.2 Stakeholders

- **Primary user:** a developer who wants to point Vise at any
  OpenAI-compatible LLM backend (llama.cpp, OpenRouter, Ollama, vLLM, etc.)
  without modifying the harness.
- **The harness:** discovers models from registered providers at startup,
  resolves a profile's active model from its whitelist, and runs the agent
  loop against the resolved model. The harness is provider-aware (it knows
  which providers are registered and which model came from which provider)
  but does not depend on any specific provider implementation.

### 1.3 Success Criteria

- A user creates `~/.vise/index.ts` with `reg.addProvider(new LlamaProvider({ url }))`,
  and Vise discovers all models from that server at startup (including router
  mode: one URL, many models).
- A profile with a `models` whitelist only sees models matching the whitelist.
  The active model is the first match, unless the state file's `lastModel` is
  also in the whitelist.
- A subagent spawned under a profile with an empty `models` spec uses the
  parent's active model.
- With no provider registered, Vise exits with a fatal error naming the
  problem. There is no silent fallback.
- Two providers serving the same model name are disambiguated by the
  `provider` field. `/model` output shows the provider context.
- The `Provider` interface is general: a future `OpenRouterProvider` or
  `OllamaProvider` can be added without modifying the harness.

### 1.4 Out of Scope

- **Non-OpenAI-compatible backends.** The harness uses a single generic
  OpenAI-compatible `LLMClient`. A provider that speaks a different wire
  protocol (e.g., Anthropic's native API) is out of scope for this spec.
  The `Provider` interface is designed to accommodate it later.
- **Provider lifecycle management.** The harness does not start, stop, or
  health-check provider backends. The user is responsible for ensuring the
  backend is running before starting Vise.
- **Per-model provider configuration.** All models discovered from a single
  provider share the provider's `baseUrl` and `apiKey`. Per-model overrides
  (e.g., different `temperature` per model) are handled by the existing
  connection-prop mechanism, not by the provider.
- **Hot-reloading of providers.** Providers are registered once at config
  time and discovered once at startup. There is no runtime add/remove.
- **Provider authentication flows** (OAuth, API key rotation, etc.). The
  provider's `apiKey` is a static string set at construction time.

---

## 2. Domain Model

### 2.1 Entities

| Entity             | Description                                                    | Key Attributes                                                                                             |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Provider**       | A config-time convention that discovers models from a backend. | `name: string` (auto-generated id), `discoverModels(): Promise<ModelDef[]>`                                |
| **LlamaProvider**  | Concrete `Provider` for an OpenAI-compatible llama.cpp server. | `url: string` (constructor), `name` (auto), `apiKey` (optional, default `""`)                              |
| **Model**          | An LLM endpoint discovered from a provider.                    | `name: string`, `baseUrl: string`, `apiKey: string`, `provider: ResourceId`, `temperature?`, `maxContext?` |
| **Profile**        | A named agent configuration (existing).                        | `name`, `systemPrompt`, `subagent?`, **`models?: ModelSelection`** (new)                                   |
| **ModelSelection** | A whitelist of models available to a profile.                  | `(string \| [string, string])[]` — see §3.4                                                                |
| **Registry**       | The factory + store (existing, extended).                      | Gains `addProvider()`, `getProvider()`, `builtins.providers`                                               |
| **ResourceGraph**  | The combined graph (existing, extended).                       | Gains `providers: ReadonlyMap<ResourceId, Provider>`, `providerNames: ReadonlyMap<string, ResourceId>`     |

### 2.2 Relationships

- A **Provider** is registered in the **Registry** via `reg.addProvider()`.
  It is **not** a graph node: it does not appear in `resources`, has no
  `ResourceId` in the graph's node map, and cannot be the source or target of
  a `Connection`. It lives in a separate `providers` side-channel on the
  `ResourceGraph`, analogous to `builtins`.
- A **Model** is created at startup by the harness (not by the config
  function). Each Model carries a `provider` field referencing the
  `ResourceId` of the Provider that discovered it. A Model is a graph node
  (`kind: "model"`) and can be the target of a `Profile → Model` connection.
- A **Profile** may declare a `models` whitelist (`ModelSelection`). The
  whitelist references providers **by name** (the provider's auto-generated
  name), not by id. At resolution time, the harness resolves names to ids via
  the registry's `providerNames` map.
- The **Registry** maintains a `providerNames` map (name → id) so that
  profile model-selection specs and `/model` output can reference providers
  by a stable, human-readable name.

### 2.3 State Transitions

**Startup (new flow):**

```
[Session start]
  → Load .vise/index.ts (if exists)
  → Call default export with Registry
  →   reg.addProvider(new LlamaProvider({ url }))  ← registers provider
  →   reg.createProfile(...)                        ← creates profile (with models?)
  →   reg.createConnection(profile, model)          ← (optional; see §3.5)
  → Build resource graph (providers in side-channel)
  → [NEW] For each provider in graph.providers:
  →     await provider.discoverModels()
  →     For each ModelDef returned:
  →       Create a Model resource (kind: "model", provider: providerId)
  → [NEW] Validate: at least one provider registered AND at least one model
  →       discovered. Otherwise → fatal error.
  → Resolve starting profile (from state file or implicit default)
  → [NEW] Resolve starting profile's active model:
  →     Get profile's models whitelist (or "all" if missing/empty)
  →     Filter discovered models by whitelist
  →     Active = lastModel (if in filtered set) else first in filtered set
  →     If no usable model → fatal error
  → Start REPL under that profile + active model
```

**`/profile` switch (modified):**

```
[User types /profile <name>]
  → Resolve profile
  → Get profile's models whitelist (or "all" if missing/empty)
  → Filter discovered models by whitelist
  → Active = lastModel (if in filtered set) else first in filtered set
  → If no usable model → abort switch, stay on current profile (existing behavior)
  → Re-resolve prompt, tools, hooks, model
```

**Subagent spawn (modified):**

```
[spawn_subagent called]
  → Resolve subagent's profile
  → If profile has a models whitelist:
  →   Filter discovered models by whitelist
  →   Active = first in filtered set
  → Else (empty/missing whitelist):
  →   Inherit parent's active model (the specific model, not just the whitelist)
  → Run subagent under that model
```

---

## 3. Functional Requirements

### 3.1 Provider Interface

The `Provider` interface is the general contract that all provider
implementations must satisfy. It is exported from the `vise` package so that
`.vise/index.ts` can import it (and concrete providers like `LlamaProvider`).

```typescript
/**
 * A provider of LLM models. A provider is a config-time convention: it is
 * registered in `.vise/index.ts` via `reg.addProvider()` and used by the
 * harness at startup to discover available models. It is NOT a graph node —
 * it does not appear in the resource graph's node map and cannot be the
 * source or target of a Connection.
 */
export interface Provider {
  /**
   * The provider's name. Used for disambiguation in model-selection specs
   * and `/model` output. Auto-generated by the registry if not supplied
   * (see §3.2). Must be unique across all registered providers.
   */
  readonly name: string;

  /**
   * Discover the models available from this provider. Called once at
   * startup by the harness. The returned `ModelDef[]` is used to create
   * Model resources in the graph. Each returned ModelDef must have a
   * non-empty `name` and `baseUrl`.
   *
   * Implementations MUST be idempotent: calling this method multiple times
   * returns the same set of models (the harness may call it once per
   * startup, but the contract does not guarantee a single call).
   *
   * @throws if the backend is unreachable or returns an error. The harness
   *   treats a throwing provider as contributing zero models (see §4, E-P1).
   */
  discoverModels(): Promise<ModelDef[]>;
}
```

**Design notes:**

- The `Provider` interface is intentionally minimal. It does not include a
  `createClient()` method because the harness uses a single generic
  OpenAI-compatible `LLMClient` for all providers. A future provider that
  speaks a non-OpenAI protocol would require extending this interface (or
  introducing a parallel `ProviderClient` interface), which is out of scope
  for this spec.
- `discoverModels()` is async because querying `/v1/models` is a network
  call. The harness awaits it at startup (see §3.6).
- The `name` field is `readonly` and set at construction time. The registry
  does not mutate it.

### 3.2 LlamaProvider

`LlamaProvider` is the first concrete `Provider` implementation. It
discovers models from an OpenAI-compatible llama.cpp `llama-server`
endpoint.

```typescript
/**
 * A Provider for an OpenAI-compatible llama.cpp server.
 *
 * The server must be running and started with `--jinja` for tool calling.
 * The provider queries `GET {url}/v1/models` to discover loaded models.
 * In router mode (one server, many models), a single LlamaProvider yields
 * one Model resource per discovered model.
 */
export class LlamaProvider implements Provider {
  readonly name: string;

  constructor(options: LlamaProviderOptions);

  async discoverModels(): Promise<ModelDef[]>;
}

export interface LlamaProviderOptions {
  /** Base URL of the llama.cpp server, e.g. `http://localhost:8080`. */
  url: string;
  /**
   * The provider's name, used for disambiguation in model-selection specs
   * and `/model` output. Omitted → auto-generated by the registry
   * (e.g., `"llama_0"`, `"llama_1"`, …). Must be unique across all
   * registered providers.
   */
  name?: string;
  /**
   * API key sent as `Authorization: Bearer <key>` to the server.
   * Omitted → `""` (no auth). Used for servers started with `--api-key`.
   */
  apiKey?: string;
}
```

**Behavior:**

- `discoverModels()` issues `GET {url}/v1/models` with the provider's
  `apiKey` (if set). It parses the response as
  `{ data: { id: string }[] }` and returns one `ModelDef` per entry:
  `{ name: entry.id, baseUrl: this.url, apiKey: this.apiKey }`.
- If the server is unreachable, returns an HTTP error, or returns an empty
  `data` array, `discoverModels()` returns `[]` (empty array). It does NOT
  throw for these conditions — the harness treats an empty result as "this
  provider contributed no models" (see §4, E-P1).
- If the response body is malformed (not valid JSON, or missing `data`),
  `discoverModels()` returns `[]`.

**Naming:**

- If `options.name` is supplied, it is used as the provider's `name`.
- If omitted, the registry assigns an auto-generated name at
  `addProvider()` time: `"llama_0"`, `"llama_1"`, … (based on the class
  name, lowercased, with a per-class counter). The auto-generated name is
  stable within a single Vise invocation but may differ across invocations
  if the order of `addProvider()` calls changes.
- Two `LlamaProvider` instances with the same explicit `name` is a fatal
  config error (see §4, E-P2).

### 3.3 Registry API Extensions

The `Registry` interface gains two methods and one `builtins` field:

```typescript
export interface Registry {
  // ... existing methods (createProfile, createHook, createTool,
  //     createModel, createConnection, setRuntime, getProfile,
  //     getModel, getTool) ...

  /**
   * Register a provider with the registry. The provider is stored in a
   * side-channel (not a graph node) and will be queried at startup to
   * discover models.
   *
   * If the provider's `name` is not set (or is empty), the registry
   * assigns an auto-generated name (see §3.2).
   *
   * @returns The provider's `ResourceId` (an opaque handle, analogous to
   *   the ids returned by `createProfile`/`createModel`). This id is used
   *   as the `provider` field on Model resources created at startup.
   *
   * @throws ViseConfigError if a provider with the same `name` is already
   *   registered (duplicate provider name, §4 E-P2).
   */
  addProvider(provider: Provider): ResourceId;

  /**
   * Look up a provider by name. Returns `undefined` if no provider with
   * that name is registered. Used by the harness at startup to resolve
   * model-selection specs (which reference providers by name) to provider
   * ids.
   */
  getProvider(name: string): ResourceId | undefined;

  builtins: {
    // ... existing (tools, defaultModel, defaultProfile) ...

    /**
     * Every registered provider, keyed by name. Populated as providers are
     * added via `addProvider()`. Empty if no providers are registered.
     */
    providers: Record<string, ResourceId>;
  };
}
```

**`ResourceGraph` extensions:**

```typescript
export interface ResourceGraph {
  // ... existing fields (resources, connections, edgesFrom, profiles, runtime) ...

  /**
   * Every registered provider, keyed by its ResourceId. Providers are NOT
   * graph nodes — they do not appear in `resources` and cannot be the
   * source or target of a Connection.
   */
  providers: ReadonlyMap<ResourceId, Provider>;

  /**
   * Provider names mapped to their ResourceId. Used to resolve
   * model-selection specs (which reference providers by name) to ids.
   */
  providerNames: ReadonlyMap<string, ResourceId>;
}
```

**`ModelDef` extension:**

```typescript
export interface ModelDef {
  /** The model identifier, e.g. `llama-3-70b`. */
  name: string;
  /** Base URL of the LLM server. */
  baseUrl: string;
  /** API key; may be empty for local servers. */
  apiKey: string;
  /** Default sampling temperature. A connection prop can override it. */
  temperature?: number;
  /** Context-window size in tokens. A connection prop can override it. */
  maxContext?: number;
  /**
   * [NEW] The ResourceId of the Provider that discovered this model.
   * Set by the harness at startup; never set by the config function.
   * Used to disambiguate models that share a name across providers.
   */
  provider?: ResourceId;
}
```

**`ProfileDef` extension:**

```typescript
export interface ProfileDef {
  /** Unique, non-empty name; the argument to `/profile <name>`. */
  name: string;
  /** System prompt for this profile. Empty string → the built-in default. */
  systemPrompt: string;
  /** Constraints on subagents spawned by this profile. */
  subagent?: SubagentPolicy;
  /**
   * [NEW] A whitelist of models available to this profile. See §3.4 for
   * the full semantics. Omitted or empty → all discovered models are
   * available.
   */
  models?: ModelSelection;
}

/**
 * A whitelist of models available to a profile.
 *
 * Each element is either:
 * - `string`: a provider name. All models from that provider are included.
 * - `[string, string]`: a tuple of `[providerName, modelRegex]`. Only models
 *   from that provider whose name matches the regex are included.
 *
 * The whitelist is a filter: it restricts which models are available, it
 * does not create or configure them. A model that matches no whitelist
 * element is not available to the profile.
 *
 * If the array is missing or empty, all discovered models are available
 * (no filtering).
 */
export type ModelSelection = (string | [string, string])[];
```

### 3.4 Profile Model Selection

A profile's `models` field (a `ModelSelection`) controls which models are
available to it and which is active by default.

**Whitelist semantics:**

- **Missing or empty array** → all discovered models are available. No
  filtering.
- **Non-empty array** → only models matching at least one element are
  available.
  - A `string` element (provider name) includes **all** models from that
    provider.
  - A `[providerName, modelRegex]` tuple includes only models from that
    provider whose `name` matches the regex (full-string match, i.e.,
    `^regex$`).
  - A provider name that does not match any registered provider is a fatal
    config error (see §4, E-P3).
  - A regex that matches no models from the named provider contributes
    nothing (not an error).

**Active model selection:**

Given the set of models available to a profile (after whitelist filtering):

1. If the state file's `lastModel` (the model name saved at the previous
   exit) is in the available set, it is the active model. This pins the
   model across restarts, even if the provider's model list changes.
2. Otherwise, the **first** model in the available set (in discovery order)
   is the active model.
3. If the available set is empty, the profile has no usable model (see §4,
   E-P4).

**Discovery order:** Models are ordered by (provider registration order,
then the order returned by the provider's `discoverModels()`). This is the
order in which Model resources are created at startup.

**`/model` command (modified):**

- `/model` lists all discovered models, grouped by provider. Each entry
  shows the provider name, the model name, and a `*` marker for the active
  model.
- `/model <name>` switches the active model to the model named `<name>`.
  If multiple providers serve a model with that name, the user must
  disambiguate: `/model <providerName>/<modelName>`. A bare `<name>` that
  matches exactly one model across all providers is accepted without
  disambiguation.
- The active model must be in the current profile's available set. Switching
  to a model outside the whitelist is rejected with an error naming the
  whitelist.

### 3.5 Profile → Model Connections (Modified)

The existing `Profile → Model` connection type is **retained** but its
semantics are clarified in the context of providers:

- A `Profile → Model` connection pins a specific model to a profile,
  overriding the whitelist's active-model selection. The connected model
  must be in the profile's available set (whitelist). If it is not, the
  connection is a fatal config error (see §4, E-P5).
- A profile with **no** `Profile → Model` connection uses the whitelist's
  active-model selection (§3.4).
- A profile with a `Profile → Model` connection **and** a `models` whitelist
  uses the connected model as the active model, and the whitelist controls
  what `/model` can switch to.
- A profile with a `Profile → Model` connection and **no** `models` whitelist
  uses the connected model as the active model, and `/model` can switch to
  any discovered model.

**Note:** In the common case (one provider, one model), the user does not
need to create a `Profile → Model` connection at all. The whitelist (or its
absence) is sufficient. The connection is useful when a profile should be
pinned to a specific model among several available ones.

### 3.6 Startup Flow (Modified)

The startup flow in `src/index.ts` is modified as follows:

```
1. Parse CLI args.
2. Load .vise/index.ts (and ~/.vise/index.ts) → build ResourceGraph.
   - Providers are registered via reg.addProvider() during config execution.
   - The graph's `providers` side-channel is populated.
3. [NEW] Discover models:
   a. If graph.providers is empty → fatal error (E-P0).
   b. For each provider (in registration order):
      - await provider.discoverModels()
      - For each ModelDef returned:
        - Create a Model resource (kind: "model", provider: providerId,
          name: def.name, baseUrl: def.baseUrl, apiKey: def.apiKey,
          temperature: def.temperature, maxContext: def.maxContext)
      - If the provider returned [] → log a warning (E-P1), continue.
   c. If zero models were discovered across all providers → fatal error (E-P0).
4. Resolve starting profile (from state file or implicit default).
5. [NEW] Resolve starting profile's active model:
   a. Get the profile's models whitelist (or "all" if missing/empty).
   b. Filter discovered models by the whitelist.
   c. Active = lastModel (if in filtered set) else first in filtered set.
   d. If no usable model → fatal error (E-P4).
6. Start REPL under that profile + active model.
```

**Key differences from the current flow:**

- The current flow's `discoverModel()` (which queries a single
  `baseUrl/v1/models` and fills in the built-in default model's name) is
  **replaced** by the provider discovery loop in step 3.
- The built-in default model (`DEFAULT_MODEL_ID`) is **removed**. There is
  no fallback model. Every model in the graph is created by provider
  discovery.
- The `withDiscoveredModel()` function (which patched the built-in default
  model's name after discovery) is **removed**. Model names are set at
  creation time (step 3b).
- The `resolveStartingModel()` function (which handled `lastModel` pinning
  and auto-discovery for the starting profile) is **replaced** by the
  whitelist-based active-model selection in step 5.

### 3.7 Subagent Model Inheritance (Modified)

When `spawn_subagent` is called:

1. The subagent's profile is resolved (existing behavior).
2. **If the subagent's profile has a non-empty `models` whitelist:**
   - Filter discovered models by the whitelist.
   - Active model = first in the filtered set.
   - (The state file's `lastModel` is NOT consulted for subagents — the
     subagent always starts with the first available model.)
3. **If the subagent's profile has no `models` whitelist (missing or empty):**
   - The subagent **inherits the parent's active model** (the specific
     model, including its `provider` field, `baseUrl`, `apiKey`,
     `temperature`, and `maxContext`).
   - The subagent's available set is all discovered models (no filtering),
     so `/model` within the subagent (if it were a REPL) could switch to
     any model. In practice, subagents do not have a REPL, so this is
     theoretical.

**Rationale:** Subagents are short-lived and scoped to a single task.
Inheriting the parent's model avoids the subagent needing its own model
configuration and ensures consistency with the parent's context. A profile
that wants to constrain a subagent's model can declare a `models` whitelist
on the subagent's profile.

### 3.8 `/model` Command (Modified)

The `/model` command is modified to reflect the provider-aware model list:

- **`/model`** (no argument): Lists all discovered models, grouped by
  provider. Format:

  ```
  Models:
    llama_0 (http://localhost:8080):
      * qwen2.5-coder-32b
      llama-3-70b
    openrouter (https://openrouter.ai/api/v1):
      anthropic/claude-sonnet-4
  ```

  The `*` marks the active model. Provider names are shown in parentheses
  with their base URL.

- **`/model <name>`**: Switches the active model.
  - If `<name>` matches exactly one model across all providers, switch to
    it (if it is in the current profile's available set).
  - If `<name>` matches multiple models (same name, different providers),
    the user must disambiguate: `/model <providerName>/<name>`.
  - If `<name>` matches no model, error: `Unknown model "<name>".`
  - If the matched model is not in the current profile's available set,
    error: `Model "<name>" is not available for profile "<profile>".
Available: <list>.`

- **`/model <providerName>/<name>`**: Switches to the specific model from
  the named provider. Same availability check as above.

### 3.9 State File (Modified)

The state file's `lastModel` field is **retained** but its semantics are
clarified:

- `lastModel` stores the **model name** (not the provider id) of the active
  model at exit.
- At startup, `lastModel` is matched against the available set by **name
  only**. If multiple providers serve a model with that name, the first one
  (in discovery order) is used. This is a known limitation: `lastModel`
  does not disambiguate across providers. A future revision may store
  `<providerName>/<modelName>` instead.
- If `lastModel` does not match any model in the available set, it is
  ignored and the first model in the available set is used (existing
  behavior).

### 3.10 Validation (Modified)

The graph validation (`validateGraph`) is extended:

- **E-P0 (no providers):** If the graph has zero providers, this is a fatal
  error. (Checked at startup, not in `validateGraph`, because the graph
  may be valid but the user simply hasn't registered any providers.)
- **E-P2 (duplicate provider name):** If two providers have the same `name`,
  this is a fatal config error. Checked in `validateGraph`.
- **E-P3 (unknown provider in whitelist):** If a profile's `models`
  whitelist references a provider name that is not registered, this is a
  fatal config error. Checked in `validateGraph`.
- **E-P5 (connected model not in whitelist):** If a profile has a
  `Profile → Model` connection to a model that is not in the profile's
  available set (whitelist), this is a fatal config error. Checked in
  `validateGraph`. (Note: this check requires knowing the discovered models,
  which are not available at validation time. This check is therefore
  deferred to startup, after model discovery.)

**Existing validation rules that are affected:**

- The `Model` resource validation (non-empty `baseUrl`, string `name`) is
  **retained** but applies to models created by the config function via
  `reg.createModel()` (which is now rare — most models are created at
  startup by provider discovery). Models created at startup are validated
  by the harness (non-empty `name` and `baseUrl` are guaranteed by the
  provider's `discoverModels()` contract).
- The `Profile → Model` connection validation (both endpoints exist, valid
  edge type) is **retained**.

### 3.11 Built-in Default Model Removal

The following are **removed**:

- `DEFAULT_MODEL_ID` (`"builtin:model:default"`) from `registry.ts`.
- The built-in default model node creation in `ViseRegistry.constructor()`.
- `DEFAULT_BASE_URL` (`"http://localhost:8080"`) as a fallback. It is
  retained as a constant for documentation purposes but is no longer used
  as a default.
- `withDiscoveredModel()` from `registry.ts`.
- `discoverModel()` from `llm/client.ts` (replaced by provider discovery).
- `resolveStartingModel()` from `src/index.ts` (replaced by whitelist-based
  selection).
- The "no model" fallback path in `resolveProfile()` (where
  `modelEdge?.to ?? DEFAULT_MODEL_ID` fell back to the built-in default).
  Now, a profile with no model edge and no whitelist-resolved model is
  fatal.

**`resolveProfile()` modification:**

- The `modelId` field of `ResolvedProfile` is now `ResourceId | null`
  (was `ResourceId`). It is `null` when the profile has no model edge and
  no whitelist-resolved model.
- The `config.model` field is `null` when no model is resolved (existing
  behavior, now more common).
- The caller (startup, `/profile` switch, subagent spawn) must check for
  `null` and handle the "no model" case (fatal or inherit, per §3.4/§3.7).

### 3.12 `LLMClient` (Unchanged)

The `LLMClient` interface and the default OpenAI-compatible implementation
(`chatCompletion`) are **unchanged**. The harness continues to use a single
generic client for all providers. The `Config` object passed to
`client.chat()` carries the resolved model's `baseUrl`, `apiKey`, `model`
(name), `temperature`, and `maxContext` — exactly as before. The provider
that discovered the model is not passed to the client; the client only
needs the endpoint and credentials.

---

## 4. Edge Cases and Error Handling

| ID   | Condition                                                                                               | Behavior                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-P0 | No providers registered, or zero models discovered                                                      | **Fatal at startup.** Message: `"No models available. Register a provider in .vise/index.ts (e.g., reg.addProvider(new LlamaProvider({ url: 'http://localhost:8080' })))."` Exit code 1.                  |
| E-P1 | A provider's `discoverModels()` returns `[]` (server unreachable, empty model list, malformed response) | **Warning to stderr.** Message: `"Provider '<name>' (<url>) returned no models. Is the server running?"` The provider contributes zero models. Startup continues if other providers have models.          |
| E-P2 | Two providers have the same `name`                                                                      | **Fatal config error.** Message: `"Duplicate provider name '<name>'. Each provider must have a unique name."` Exit code 1.                                                                                |
| E-P3 | A profile's `models` whitelist references an unknown provider                                           | **Fatal config error.** Message: `"Profile '<profile>' references unknown provider '<name>' in its models whitelist. Registered providers: <list>."` Exit code 1.                                         |
| E-P4 | A profile resolves to no usable model (empty available set)                                             | **Fatal at startup** (for the starting profile) or **abort switch** (for `/profile`). Message: `"Profile '<name>' has no available models."` The session is left on the current profile (for `/profile`). |
| E-P5 | A profile's `Profile → Model` connection targets a model not in its whitelist                           | **Fatal at startup** (after model discovery). Message: `"Profile '<name>' is connected to model '<model>' which is not in its models whitelist."` Exit code 1.                                            |
| E-P6 | `/model <name>` matches multiple providers                                                              | **Error (non-fatal).** Message: `"Model '<name>' is ambiguous. Use '<provider>/<name>' to disambiguate. Providers: <list>."` The session is left unchanged.                                               |
| E-P7 | `/model <name>` targets a model not in the current profile's available set                              | **Error (non-fatal).** Message: `"Model '<name>' is not available for profile '<profile>'. Available: <list>."` The session is left unchanged.                                                            |
| E-P8 | A subagent's profile has a `models` whitelist that matches no models                                    | **The subagent inherits the parent's active model** (fallback). A warning is logged to stderr. The subagent runs under the parent's model.                                                                |

**Existing error conditions that are affected:**

- **E3 (server unreachable):** The message is updated from
  `"Cannot reach llama.cpp server at <baseUrl>"` to
  `"Cannot reach LLM server at <baseUrl>"` (provider-agnostic). The error
  class `ServerUnreachableError` is retained but its message no longer
  mentions llama.cpp.
- **`ProfileHasNoModelError`:** The message is updated from
  `"start a llama.cpp server so the default model can be auto-discovered"`
  to `"register a provider in .vise/index.ts or connect a Model resource to
this profile"`.

---

## 5. Non-Functional Requirements

- **Performance:** Provider discovery (step 3 of the startup flow) is
  sequential (providers are queried one at a time, in registration order).
  For a typical setup (1–3 providers, each with <10 models), this adds
  <1 second to startup. Parallel discovery is a future optimization.
- **Scalability:** The design supports an arbitrary number of providers and
  models. The `providers` side-channel and `providerNames` map are
  `Map`-based (O(1) lookup). The whitelist filtering is O(P × M) where P is
  the number of whitelist elements and M is the number of discovered models.
  For realistic sizes (P < 10, M < 100), this is negligible.
- **Security:** The provider's `apiKey` is stored in the `ModelDef` and
  passed to the `LLMClient` as a `Bearer` token. It is not logged, not
  persisted to the state file, and not exposed in `/model` output. The
  state file stores only the model **name**, not the API key.
- **Compatibility:** The `Provider` interface and `LlamaProvider` are
  exported from the `vise` package. Existing `.vise/index.ts` files that do
  not use providers will fail at startup with E-P0 (no providers
  registered). This is a **breaking change** — users must add at least one
  provider to their config.
- **Backwards compatibility:** The `reg.createModel()` API is **retained**
  for users who want to declare a model explicitly (without a provider).
  Such models have no `provider` field (it is `undefined`) and are not
  subject to provider discovery. They are available to profiles that
  reference them via a `Profile → Model` connection or a whitelist that
  matches their name. This allows a migration path: users can start by
  adding a provider alongside their existing `createModel()` calls, then
  remove the explicit models once the provider is working.

---

## 6. Data Requirements

- **Input formats:**
  - `.vise/index.ts`: TypeScript module, default export `(reg: Registry) => void`.
    Providers are registered via `reg.addProvider(new LlamaProvider({ url }))`.
  - Provider discovery: `GET {url}/v1/models` → `{ data: { id: string }[] }`.
- **Output formats:**
  - `/model` listing: grouped by provider, with `*` for the active model.
  - State file: `{ profile: string, savedAt: string, lastModel: string }`
    (unchanged).
- **Storage:**
  - Providers are in-memory only (registered at config time, discarded at
    exit). They are not persisted.
  - Discovered models are in-memory only (created at startup, discarded at
    exit). They are not persisted.
  - The state file persists the active profile name and last model name
    (unchanged).

---

## 7. External Dependencies

| Dependency                       | Role                       | Notes                                                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI-compatible LLM server** | The LLM backend.           | Must expose `GET /v1/models` and `POST /v1/chat/completions` (streaming via SSE). llama.cpp `llama-server` (with `--jinja`), OpenRouter, Ollama, vLLM, and any other OpenAI-compatible server are supported. The harness does not start or manage the server. |
| **Node.js `fetch`**              | HTTP client for discovery. | Used by `LlamaProvider.discoverModels()` to query `/v1/models`. No new dependencies.                                                                                                                                                                          |

---

## 8. Constraints and Assumptions

- **C1.** The LLM backend is **OpenAI-compatible** (exposes
  `/v1/chat/completions` and `/v1/models`). Non-OpenAI backends are out of
  scope (see §1.4).
- **C2.** Tool calling requires the server to support OpenAI-style tool
  calls (llama.cpp: `--jinja`; OpenRouter: model must support tools;
  Ollama: model must support tools). The harness does not verify this.
- **C3.** The user is responsible for starting a compatible LLM server and
  ensuring it is reachable before starting Vise. The harness does not start,
  stop, or health-check the server.
- **C4.** Provider discovery is **sequential** (providers are queried one at
  a time). For a large number of providers, this may add noticeable startup
  latency. Parallel discovery is a future optimization.
- **C5.** The `lastModel` field in the state file stores the model **name**
  only, not the provider id. If two providers serve a model with the same
  name, `lastModel` disambiguates by discovery order (first match wins).
  This is a known limitation (see §3.9).
- **C6.** A profile's `models` whitelist is a **filter**, not a
  configuration. It does not set `temperature`, `maxContext`, or other model
  parameters. Those are set by the provider's `discoverModels()` return
  value or by connection props (existing mechanism).
- **A1.** The user has at least one OpenAI-compatible LLM server running
  before starting Vise.
- **A2.** The user's `.vise/index.ts` registers at least one provider.
  Without a provider, Vise exits with E-P0.
- **A3.** The graph is a DAG (existing assumption). Providers are not graph
  nodes, so they cannot participate in cycles.

---

## 9. Acceptance Criteria

- **P1.** A user creates `~/.vise/index.ts` with
  `reg.addProvider(new LlamaProvider({ url: "http://localhost:8080" }))`.
  Vise starts, discovers all models from the server (including router mode:
  one URL, many models), and lists them under `/model`.
- **P2.** A profile with `models: ["llama_0"]` only sees models from the
  `llama_0` provider. A profile with `models: [["llama_0", "^qwen.*$"]]`
  only sees `llama_0` models whose name matches `^qwen.*$`.
- **P3.** A profile with no `models` field sees all discovered models. The
  active model is the first discovered model (or `lastModel` if permissible).
- **P4.** A subagent spawned under a profile with no `models` field uses the
  parent's active model.
- **P5.** With no provider registered, Vise exits with a fatal error (E-P0)
  naming the problem. There is no silent fallback.
- **P6.** Two providers serving the same model name are disambiguated in
  `/model` output and `/model <name>` switching.
- **P7.** The `Provider` interface is general: a mock provider (in tests)
  that returns a fixed set of models works without modifying the harness.
- **P8.** The built-in default model is removed: `DEFAULT_MODEL_ID` does not
  exist, `withDiscoveredModel()` does not exist, and a profile with no model
  edge and no whitelist-resolved model is fatal.
- **P9.** `reg.createModel()` still works: a user can declare a model
  explicitly (without a provider) and connect it to a profile. The model has
  no `provider` field and is available to profiles that reference it.
- **P10.** The `LLMClient` is unchanged: the agent loop, session, and
  subagent code do not reference providers. They only see the resolved
  `Config` (baseUrl, apiKey, model name, temperature, maxContext).

---

## 10. Open Questions

- **OQ1.** Should `lastModel` in the state file be extended to store
  `<providerName>/<modelName>` for cross-provider disambiguation? (Currently
  stores name only; see C5.)
- **OQ2.** Should provider discovery be parallel (Promise.all) rather than
  sequential? (Currently sequential; see C4.)
- **OQ3.** Should the `Provider` interface include a `createClient()` method
  to support non-OpenAI-compatible backends in the future? (Currently out of
  scope; see §1.4.)
- **OQ4.** Should `reg.addProvider()` return `void` instead of `ResourceId`?
  The id is useful for the `provider` field on Model resources, but the user
  rarely needs it directly. (Currently returns `ResourceId`.)
- **OQ5.** Should the `models` whitelist support a `"*"` wildcard element
  (meaning "all providers") as a shorthand for an empty array? (Currently,
  an empty array already means "all".)
