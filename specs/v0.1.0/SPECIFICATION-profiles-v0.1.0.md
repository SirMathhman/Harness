# System Specification: Profiles & Resource Graph

**Version:** 0.1.0
**Date:** 2026-09-04
**Builds on:** 0.1.0

**Changes from 0.1.0:**

- Added `subagent` policy field to Profile: restricts which profiles subagents
  can run under (`profiles`) and max nesting depth (`maxDepth`).
- `spawn_subagent` tool gains a required `profile` parameter (no fallback to
  the parent's profile).
- Added §3.12 (Subagent Policy) and updated acceptance criteria.

---

## 1. Purpose and Scope

### 1.1 Purpose

Introduce a **profiles and resource graph** system that:

- Lets users define named **profiles** (a system prompt + associated resources)
  and switch between them at runtime.
- Models all agent capabilities (tools, hooks, models) as **resources** in a
  graph, connected by explicit **edges**.
- Provides a single, composable, type-checked configuration file (`.vise/index.ts`)
  as the sole source of truth for all agent configuration.
- Replaces the previous config system (env vars, separate config files) with one
  TypeScript module.

### 1.2 Project Rename

The project is renamed from **Harness** to **Vise**.

- CLI binary: `vise`
- Config directory: `./.vise/`
- Config entry point: `./.vise/index.ts`
- Package name: `vise` (or `@vise/cli`)

### 1.3 Stakeholders

- **Primary user:** a developer who wants to run different "modes" of the agent
  (e.g., a strict implementation mode with test hooks, a read-only exploration
  mode, a spec-writing mode) without restarting the CLI.
- **The agent:** operates under the active profile's system prompt and has access
  only to the resources connected to that profile.

### 1.4 Success Criteria

- A user creates `./.vise/index.ts`, defines profiles and resources, and the agent
  runs under the default profile.
- The user types `/profile refactor` and the agent's system prompt, available
  tools, active hooks, and model all change to match the "refactor" profile.
- A profile with no hook edges has no hooks firing. A profile with hook edges has
  only those hooks active.
- The config file is composable: `./.vise/index.ts` can import and call other
  config files that share the same shape.
- TypeScript provides full type-checking of the config (resource shapes,
  connection references via opaque IDs).
- If `./.vise/index.ts` does not exist, the agent runs with built-in defaults
  (all built-in tools, default model, no hooks, built-in system prompt).
- A profile's subagent policy restricts which profiles subagents can use and how
  deep nesting can go.

### 1.5 Out of Scope

- Multiple simultaneously active profiles (exactly one is always active).
- Profile inheritance (each profile is independent; no "extends").
- Wildcard tool references (all tools must be enumerated by ID).
- Runtime creation/deletion of resources (the graph is built at session start).
- MCP (Model Context Protocol) tool integration (future work; the resource graph
  is designed to accommodate it).
- Circular dependency detection (the graph is assumed to be a DAG in practice;
  the resolver uses visited-set traversal to avoid infinite loops).

---

## 2. Domain Model

### 2.1 Entities

| Entity             | Description                                              | Key Attributes                                                          |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Profile**        | A named agent configuration.                             | `name: string`, `systemPrompt: string`, `subagent?: SubagentPolicy`     |
| **Hook**           | A lifecycle handler (same as hooks spec).                | `events: HookEvent[]`, `handler: HookHandler`, `includeSubagents?`      |
| **Tool**           | A callable capability (same as existing Tool interface). | `name`, `parameters`, `handler`, `mutating`, `description`              |
| **Model**          | An LLM endpoint configuration.                           | `baseUrl`, `apiKey`, `name`, `temperature?`, `maxContext?`              |
| **Connection**     | A directed edge between two resources.                   | `from: ResourceId`, `to: ResourceId`, `props?: Record<string, unknown>` |
| **Registry**       | The factory + store for all resources and connections.   | Internal: maps of ID → resource, ID → connections                       |
| **ResourceId**     | An opaque string identifying a resource.                 | `string` (user-provided or auto-generated)                              |
| **SubagentPolicy** | Constraints on subagents spawned by a profile.           | `profiles?: string[]`, `maxDepth?: number`                              |

### 2.2 Relationships

The system is a **directed graph**:

- **Nodes** are resources: profiles, hooks, tools, models.
- **Edges** are connections between resources.

Connection types (directed):

| From    | To    | Meaning                                                | Props (optional)              |
| ------- | ----- | ------------------------------------------------------ | ----------------------------- |
| Profile | Hook  | This hook is active for this profile                   | —                             |
| Profile | Tool  | This tool is available for this profile                | —                             |
| Profile | Model | This model is used for this profile                    | `temperature?`, `maxContext?` |
| Hook    | Tool  | This hook only fires when one of these tools is called | —                             |

**Resolution rule:** Starting from the active profile, follow its outgoing edges
to determine the active set of hooks, tools, and model. The graph is traversed
with a visited set (no infinite loops).

### 2.3 State Transitions

```
[Session start]
  → Load .vise/index.ts (if exists)
  → Call default export with Registry
  → Build resource graph
  → Resolve default profile → active config
  → [Running]

[Running]
  → /profile <name>
  → Resolve named profile → new active config
  → Re-resolve: system prompt, tools, hooks, model
  → [Running with new profile]

[Running]
  → Agent calls spawn_subagent({ profile: 'worker', ... })
  → Validate against active profile's subagent policy
  → Spawn subagent under 'worker' profile
  → [Subagent running]
```

---

## 3. Functional Requirements

### 3.1 Configuration File

- **Location:** `./.vise/index.ts` (relative to the project root / cwd).
- **Shape:** A TypeScript ES module with a default export of type
  `(reg: Registry) => void`.
- **Optional:** If the file does not exist, the agent runs with built-in
  defaults (see §3.8).
- **Loading:** The file is dynamically imported at session start. The default
  export is called with a fresh `Registry` instance.
- **Composability:** The file can import other modules that also export
  `(reg: Registry) => void` and call them:

```ts
// .vise/index.ts
import { setup as lintHooks } from "./hooks/lint.js";
import { setup as testHooks } from "./hooks/tests.js";

export default (reg: Registry) => {
  lintHooks(reg);
  testHooks(reg);

  const impl = reg.createProfile({ name: "implement", systemPrompt: "..." });
  const testHook = reg.createHook({ events: ["turn:end"], handler: runTests });
  reg.createConnection(impl, testHook);
};
```

### 3.2 Registry API

The `Registry` is passed to the config function. It provides:

```ts
interface Registry {
  /** Create a profile resource. Returns its ID. */
  createProfile(def: ProfileDef): ResourceId;

  /** Create a hook resource. Returns its ID. */
  createHook(def: HookDef): ResourceId;

  /** Create a custom tool resource. Returns its ID. */
  createTool(def: ToolDef): ResourceId;

  /** Create a model resource. Returns its ID. */
  createModel(def: ModelDef): ResourceId;

  /** Create a directed connection between two resources. */
  createConnection(
    from: ResourceId,
    to: ResourceId,
    props?: Record<string, unknown>,
  ): void;

  /** Set the profile switch mode. */
  setProfileSwitchMode(mode: "replace" | "append"): void;

  /** Well-known IDs for built-in resources. */
  builtins: {
    tools: Record<string, ResourceId>; // e.g., { read_file: 'builtin:read_file', ... }
    defaultModel: ResourceId; // the default model
    defaultProfile: ResourceId; // the empty default profile
  };
}
```

**ID generation:** If the user does not provide a name/ID, the Registry
auto-generates one (e.g., `profile_0`, `hook_1`). For profiles, the `name` field
is required (used by `/profile <name>`). For other resources, the ID is
auto-generated unless the user passes one.

**Built-in tool IDs:** All built-in tools (read_file, write_file, edit_file,
search, list_dir, run_command, spawn_subagent, finish, etc.) are pre-registered
with IDs of the form `builtin:<tool_name>`. The user references them in
connections via `reg.builtins.tools.read_file`, etc.

### 3.3 Resource Definitions

#### Profile

```ts
interface ProfileDef {
  /** Unique name, used by /profile <name>. */
  name: string;
  /** The system prompt for this profile. Empty string = use built-in default. */
  systemPrompt: string;
  /** Constraints on subagents spawned by this profile. */
  subagent?: SubagentPolicy;
}

interface SubagentPolicy {
  /**
   * Which profiles subagents can run under. If omitted, subagents can use
   * any profile. If specified, only these profile names are valid for the
   * `profile` parameter of spawn_subagent.
   */
  profiles?: string[];

  /**
   * Maximum nesting depth for subagents. 0 = no subagents allowed.
   * 1 = subagents can spawn (but their subagents cannot).
   * 2 = subagents can spawn subagents (but not further).
   * If omitted, no limit (same as current behavior).
   */
  maxDepth?: number;
}
```

#### Hook

Same shape as the hooks spec (`Hook` interface):

```ts
interface HookDef {
  events: HookEvent[];
  handler: HookHandler;
  includeSubagents?: boolean;
}
```

#### Tool

Same shape as the existing `Tool` interface:

```ts
interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  mutating: boolean;
  handler(args: Record<string, unknown>): Promise<string>;
}
```

#### Model

```ts
interface ModelDef {
  /** The model identifier (e.g., 'llama-3-70b'). */
  name: string;
  /** Base URL of the LLM server. */
  baseUrl: string;
  /** API key (may be empty for local servers). */
  apiKey: string;
  /** Default temperature. Can be overridden per-connection. */
  temperature?: number;
  /** Max context window size. */
  maxContext?: number;
}
```

### 3.4 Connections

A connection is a directed edge: `from → to`.

```ts
reg.createConnection(profileId, hookId);
reg.createConnection(profileId, toolId);
reg.createConnection(profileId, modelId, { temperature: 0.2 });
reg.createConnection(hookId, toolId);
```

**Rules:**

- `from` and `to` must be valid `ResourceId`s (guaranteed by the type system —
  IDs are only obtainable from `create*` methods or `reg.builtins`).
- Connection types are determined by the resource types of `from` and `to`:
  - Profile → Hook: hook is active for that profile.
  - Profile → Tool: tool is available for that profile.
  - Profile → Model: model is used for that profile (props can override params).
  - Hook → Tool: hook only fires when one of these tools is called.
- Other combinations (e.g., Tool → Profile) are invalid and cause a fatal error
  at load time.
- Multiple connections between the same pair are allowed (e.g., a hook connected
  to multiple tools).
- Connections are directional. A Profile→Hook edge does NOT imply a Hook→Profile
  edge.

### 3.5 Resolution

At session start (and on `/profile <name>`), the active configuration is
resolved by traversing the graph from the active profile:

1. **System prompt:** From the profile's `systemPrompt` field. If empty string,
   use the harness's built-in default system prompt.
2. **Tools:** Collect all Tool resources reachable via Profile→Tool edges from
   the active profile. If the profile has NO tool edges, all built-in tools are
   available (default behavior). Custom tools must be explicitly connected.
3. **Hooks:** Collect all Hook resources reachable via Profile→Hook edges from
   the active profile. If the profile has NO hook edges, no hooks are active.
   For each active hook, check Hook→Tool edges: if present, the hook only fires
   when one of those tools is called.
4. **Model:** Collect the Model resource via Profile→Model edge. If no edge, use
   the global default model (`reg.builtins.defaultModel`). Connection props
   (e.g., `temperature`) override the model's own params.
5. **Subagent policy:** Read from the profile's `subagent` field. Used to
   validate `spawn_subagent` calls.

**Resolution is a pure function of the graph + active profile.** No side effects.

### 3.6 Profile Switching

- **Command:** `/profile <name>` — switch to the named profile.
- **Command:** `/profile` (no arg) — list all profiles, mark the active one.
- **Effect:** Full re-resolution. The system prompt, available tools, active
  hooks, and model all change to match the new profile.
- **Conversation history:** Retained. The system prompt is either:
  - **Replaced:** The existing system message is updated to the new profile's
    prompt. (Default behavior.)
  - **Appended:** A new system message is added with the new profile's prompt;
    the old one remains.
- **Switch mode:** Configured via `reg.setProfileSwitchMode('replace' | 'append')`.
  Default: `'replace'`.
- **Invalid name:** `/profile nonexistent` → error message in the REPL, no
  switch occurs.

### 3.7 Hook-Tool Filtering

When a Hook has Hook→Tool edges, the hook only fires when the tool being called
matches one of the connected tools.

- For `tool:before` / `tool:after` events: the hook fires only if
  `ctx.tool.name` matches a connected tool's name.
- For non-tool events (`turn:end`, `session:start`, etc.): Hook→Tool edges are
  irrelevant; the hook fires normally.
- If a hook has NO Hook→Tool edges, it fires for all tools (no filtering).

### 3.8 Built-in Defaults (No Config File)

If `./.vise/index.ts` does not exist:

- **Profile:** One implicit default profile (empty name, built-in system prompt,
  no subagent policy).
- **Tools:** All built-in tools are available.
- **Hooks:** No hooks.
- **Model:** The default model (resolved from the existing model discovery
  mechanism — auto-detect from the running llama.cpp server).

This is equivalent to the current behavior (no profiles, no hooks).

### 3.9 REPL Commands

| Command           | Effect                                                |
| ----------------- | ----------------------------------------------------- |
| `/profile`        | List all profiles. Mark the active one with `*`.      |
| `/profile <name>` | Switch to the named profile. Full re-resolution.      |
| `/hooks`          | (Existing) List active hooks for the current profile. |
| `/hooks off`      | (Existing) Disable hooks.                             |
| `/hooks on`       | (Existing) Re-enable hooks.                           |

### 3.10 Configuration Loading

1. At session start, check for `./.vise/index.ts`.
2. If present: dynamic `import()`, call the default export with a fresh
   `Registry`.
3. If the file throws, has no default export, or the export is not a function:
   **fatal error** — exit with a descriptive message.
4. After the config function completes, the Registry contains all resources and
   connections.
5. Resolve the default profile (the one named `'default'`, or the first profile
   if no `'default'` exists, or the implicit empty profile if no profiles are
   defined).
6. Build the active tool set, hook set, model config, and subagent policy.
7. Start the session.

### 3.11 Validation

At load time (after the config function completes):

- Every connection's `from` and `to` must reference existing resources
  (guaranteed by the ID system, but validated defensively).
- Connection types must be valid (Profile→Hook, Profile→Tool, Profile→Model,
  Hook→Tool). Invalid combinations → fatal error.
- Profile names must be unique. Duplicate → fatal error.
- Tool names must be unique (across built-in + custom). Duplicate → fatal error.
- A profile with no model edge and no global default model → fatal error
  (cannot run without a model).
- Subagent policy `profiles` must reference existing profile names. Unknown
  name → fatal error.

### 3.12 Subagent Policy

The `spawn_subagent` tool gains a `profile` parameter:

```ts
// spawn_subagent parameters (updated):
{
  task: string;       // required: the task description
  profile: string;    // required: which profile the subagent runs under
}
```

**Behavior:**

1. **`profile` param (required):** The subagent runs under the named profile.
2. **Validation:** The name is validated against the parent's subagent policy:
   - If `subagent.profiles` is set and the name is NOT in the list → tool
     returns an error: `"Profile 'X' is not allowed for subagents. Allowed: [a, b, c]"`.
   - If `subagent.profiles` is not set → any profile name is valid.
3. **Depth check:** The current depth is tracked (main agent = 0, its subagents
   = 1, their subagents = 2, etc.).
   - If `subagent.maxDepth` is set and `currentDepth + 1 > maxDepth` → tool
     returns an error: `"Subagent depth limit reached (max: N)"`.
   - If `subagent.maxDepth` is not set → no limit.
4. **Subagent's own policy:** The subagent runs under its own profile's
   subagent policy. So if profile "worker" has `maxDepth: 1`, a subagent
   running under "worker" cannot spawn further subagents.
5. **Subagent's tools/hooks/model:** Resolved from the subagent's profile
   (same resolution as §3.5). The subagent gets its own system prompt, tool
   set, hooks, and model based on its profile.

**Example:**

```ts
const impl = reg.createProfile({
  name: "implement",
  systemPrompt: "You are an implementation agent...",
  subagent: {
    profiles: ["worker", "researcher"],
    maxDepth: 2,
  },
});

const worker = reg.createProfile({
  name: "worker",
  systemPrompt: "You are a focused worker...",
  subagent: { maxDepth: 1 }, // workers can spawn one level of subagents
});

const researcher = reg.createProfile({
  name: "researcher",
  systemPrompt: "You are a research agent...",
  subagent: { maxDepth: 0 }, // researchers cannot spawn subagents
});
```

In this example:

- Main agent (implement) can spawn subagents with profile "worker" or
  "researcher", up to depth 2.
- A "worker" subagent can spawn one more level (depth 2), but not further.
- A "researcher" subagent cannot spawn any subagents.

---

## 4. Edge Cases and Error Handling

| Scenario                                                 | Behavior                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `./.vise/index.ts` does not exist                        | Run with built-in defaults. No error.                             |
| `./.vise/index.ts` has a syntax error                    | Fatal: exit with error message.                                   |
| Default export is not a function                         | Fatal: exit with descriptive error.                               |
| Config function throws                                   | Fatal: exit with the error message.                               |
| Duplicate profile name                                   | Fatal: exit, identifying the duplicate.                           |
| Duplicate tool name (custom shadows built-in)            | Fatal: exit, identifying the conflict.                            |
| Connection references a non-existent ID                  | Impossible (IDs are opaque, only from create\* or builtins).      |
| Invalid connection type (e.g., Tool→Profile)             | Fatal: exit, identifying the invalid edge.                        |
| `/profile <name>` with unknown name                      | REPL error message; no switch.                                    |
| Profile switch while a turn is in progress               | Switch takes effect at the start of the NEXT turn (not mid-turn). |
| Profile has no tool edges                                | All built-in tools available (default).                           |
| Profile has tool edges                                   | Only those tools available.                                       |
| Profile has no hook edges                                | No hooks active.                                                  |
| Profile has hook edges                                   | Only those hooks active.                                          |
| Hook has tool edges, but a non-connected tool is called  | Hook does not fire for that tool.                                 |
| Model connection has `temperature` prop                  | Overrides the model's own temperature for that profile.           |
| Two profiles connect to the same hook                    | Fine. The hook is active for both profiles (independently).       |
| Config file imports a module that also calls create\*    | Fine. All resources are registered in the same Registry.          |
| `spawn_subagent` with profile not in `subagent.profiles` | Tool returns error listing allowed profiles.                      |
| `spawn_subagent` exceeds `maxDepth`                      | Tool returns error with the depth limit.                          |
| `spawn_subagent` with no `profile` param                 | Tool returns error: `'profile' is required`.                      |
| Subagent's profile has `maxDepth: 0`                     | Subagent cannot spawn further subagents.                          |
| Subagent policy references a non-existent profile name   | Fatal at load time.                                               |

---

## 5. Non-Functional Requirements

- **Type safety:** The config file is fully type-checked by TypeScript. Resource
  IDs are opaque (not plain strings the user can forge), so connection
  references are safe by construction.
- **Performance:** Graph resolution is O(V + E) where V = resources, E =
  connections. For realistic configs (< 100 resources), this is negligible.
  Profile switching re-resolves in the same time.
- **Composability:** Any number of config files can contribute resources to the
  same Registry. No global state, no singletons.
- **Zero overhead without config:** If no `.vise/index.ts` exists, the
  Registry is never instantiated (or is trivially empty). No measurable
  overhead.
- **Testability:** The Registry and resolution logic are pure (given a graph →
  active config). No I/O in the resolver.

---

## 6. Data Requirements

- **Input:** TypeScript ES module(s) at `./.vise/`.
- **Output:** None (configuration affects the session in-place).
- **Storage:** In-memory for the session lifetime. No persistence.

---

## 7. External Dependencies

- None new. The config file is a local TypeScript module. Model resources
  reference LLM servers (llama.cpp) but that's the existing dependency.

---

## 8. Constraints and Assumptions

- **Single config entry point.** `./.vise/index.ts` is the root. Other files are
  imported by it. There is no auto-discovery of config files.
- **No env vars.** All configuration lives in the TypeScript config file.
  Environment variables are not read for agent configuration. (The LLM server
  URL/key can still come from the Model resource in config.)
- **Sync config loading.** The config function is synchronous. No async setup.
- **No runtime mutation.** Resources and connections are created at session
  start and cannot be added/removed during the session. (Profile switching
  changes which resources are _active_, not which exist.)
- **Exactly one active profile.** No multi-profile composition.
- **No inheritance.** Profiles do not extend or inherit from each other.
- **DAG assumption.** The graph is assumed to be acyclic. The resolver uses a
  visited set to prevent infinite loops, but does not report cycles as errors.
- **Built-in tools are immutable.** Users cannot modify or remove built-in tools.
  They can only choose which are active per profile.
- **Subagent depth is per-profile.** Each profile's `maxDepth` applies to
  subagents spawned _by_ that profile. A subagent's own profile determines its
  spawning ability.

---

## 9. Acceptance Criteria

1. A user creates `./.vise/index.ts` with two profiles ("default" and
   "refactor"), a model, and connections. The agent starts under "default".
2. `/profile` lists both profiles with "default" marked active.
3. `/profile refactor` switches: the system prompt changes, the tool set changes
   (e.g., no write_file in refactor profile), and the model changes if
   connected.
4. A hook connected to the "implement" profile fires on `turn:end` for that
   profile but NOT for "refactor".
5. A hook with a Hook→Tool edge to `write_file` only fires when `write_file` is
   called, not for `read_file`.
6. A profile with no tool edges has all built-in tools available.
7. A profile with tool edges to `read_file` and `search` only has those two
   tools.
8. No `./.vise/index.ts` → agent runs with all built-in tools, default model,
   no hooks, built-in prompt. (Same as current behavior.)
9. A config file that throws → fatal exit with the error message.
10. `/profile nonexistent` → error in REPL, no switch.
11. A composable config: `./.vise/index.ts` imports `./.vise/hooks/tests.ts`
    which calls `reg.createHook(...)`. The hook is available for connection.
12. Model connection with `{ temperature: 0.2 }` overrides the model's default
    temperature for that profile only.
13. `spawn_subagent({ task: '...', profile: 'worker' })` where "worker" is in
    the active profile's `subagent.profiles` → subagent runs under "worker"
    profile with its own prompt/tools/hooks/model.
14. `spawn_subagent({ task: '...', profile: 'forbidden' })` where "forbidden"
    is NOT in `subagent.profiles` → tool returns error listing allowed profiles.
15. `spawn_subagent` at depth 1 with active profile `maxDepth: 1` → succeeds.
    At depth 2 → tool returns error "depth limit reached".
16. `spawn_subagent` with no `profile` param → tool returns an error
    (`'profile' is required`); the subagent never falls back to the parent's
    profile.
17. Subagent running under a profile with `maxDepth: 0` → its
    `spawn_subagent` calls always return a depth-limit error.

---

## 10. Open Questions

(None — specification is complete.)
