# Vise — Canonical Architecture

This document describes the ideal architecture for the Vise coding-agent harness.
It is a reference for where the project is heading, not a description of the
current state. It should always sit ahead of the code.

---

## Definitions

| Term | Meaning |
|------|---------|
| **Resource graph** | A directed graph whose nodes are *resources* (profiles, hooks, tools, models) and whose edges are *connections*. Configuration is a description of this graph. |
| **Resource** | A node in the graph. Four kinds: `profile`, `hook`, `tool`, `model`. Each carries an opaque `ResourceId`. |
| **Connection** | A directed edge between two resources, optionally carrying props. Only Profile→Hook, Profile→Tool, Profile→Model, and Hook→Tool are valid. |
| **Profile** | A named agent configuration: system prompt, tool set, hook set, model whitelist, and subagent policy. |
| **Provider** | A config-time convention (not a graph node) that discovers models at startup and may contribute hooks. Registered via `reg.addProvider()`. |
| **Model** | An LLM endpoint (name, baseUrl, apiKey, temperature). Either declared directly or discovered by a provider. The context window is deliberately absent: it belongs to the model as the server has it loaded, and is learned at runtime. |
| **Hook** | A lifecycle handler subscribed to one or more `HookEvent`s. Per-profile, except provider-contributed hooks which merge into every session. |
| **Tool** | A callable capability exposed to the model. Built-in or user-defined. Mutating tools run sequentially; read-only tools run concurrently. |
| **Skill** | A named body of deferred context. Global side-channel (not a graph node); visible to every agent at every depth. |
| **Session** | One REPL invocation: a message list, a resolved `Config`, a `HookManager`, a depth, and a profile name. |
| **Subagent** | A nested agent run spawned by the `spawn_subagent` tool. Has its own isolated session, registry, hooks, and background-command manager. |
| **Wire seam** | The single serialize/parse boundary between the internal domain model (`Message`/`ToolCall`) and the OpenAI wire format. One in (`accumulate` in `llm/sse.ts`), one out (`toWireMessage` in `llm/client.ts`). |
| **Startup seam** | `prepareSession()` in `src/startup.ts`. The single entry point both the CLI and the agent-server call to resolve config → models → profile. |

### Core invariants

- **Error semantics:** tool errors are returned to the model as result strings (the agent self-corrects). Only `LLMError` (connectivity) aborts the turn. Never throw a tool error up to the loop.
- **Tool execution ordering:** mutating tools run sequentially in model order; read-only tools run concurrently. Results are always returned in original tool-call order. `spawn_subagent` is read-only unless the active provider sets `serializeSubagents`.
- **`finish` is terminal** unless a `turn:end` hook rejects it.
- **Hooks are synchronous only**, except the four subagent events whose handlers may be async.
- **`src/index.ts` must stay side-effect-free.**
- **The wire seam is one in, one out.** No other module reads or writes the wire format.
- **The protocol is additive-only.** The client ignores unknown event types.
- **`prepareSession()` is the single startup seam.** A new presentation surface calls it, never re-copies the startup prefix.

---

## Structure

### Module layout and dependency direction

```
src/
  types.ts          # Core domain types: Message, ToolCall, Tool, Config, Session,
                    # ResourceId, ModelDef, Skill, JsonSchema, BackgroundCommand,
                    # Usage, LLMResponse. No imports from any other src/ module.
  utils.ts          # Pure helpers: truncate, resolvePath, resolveShell, looksBinary,
                    # newId, homeDir. No domain imports.
  config/
    defaults.ts     # Built-in prompt/runtime/config defaults.
  llm/
    errors.ts       # LLMError. No domain imports.
    sse.ts          # Parse seam: accumulate() — wire → domain.
    client.ts       # Serialize seam: toWireMessage() — domain → wire.
                    # defaultLLMClient. Imports llm/errors, llm/sse, types.
  hooks/
    types.ts        # HookEvent, Hook, HookContext, HookResult, HookHandler.
                    # No imports from profiles/ or providers/.
    manager.ts      # HookManager: dispatch, dispatchAsync.
    index.ts        # Re-exports.
  providers/
    types.ts        # Provider interface, ModelDef. Imports types (ResourceId),
                    # hooks/types (Hook). Does NOT import from profiles/.
    llamaProvider.ts# LlamaProvider implementation.
    index.ts        # Re-exports.
  profiles/
    types.ts        # Resource graph types: ResourceId (re-exported from types.ts),
                    # ResourceKind, ResourceOrigin, SubagentPolicy, ProfileDef,
                    # ModelSelection, HookDef, ToolDef, RuntimeSettings, Connection,
                    # ProfileSwitchMode, Registry, ViseConfig, Resource.
                    # Imports types (ResourceId, ModelDef, Tool, Skill),
                    # hooks/types (Hook), providers/types (Provider).
                    # Does NOT define ResourceId or ModelDef.
    registry.ts     # ViseRegistry: create*, get*, addProvider, createConnection,
                    # setRuntime, builtins.
    resolve.ts      # resolveProfile, availableModelIds, systemPromptOf, etc.
    validate.ts     # validateGraph, ViseConfigError.
    load.ts         # buildGraphFrom, loadViseConfig, findConfigEntry.
    state.ts        # resolveStartingProfile, stateFilePath, writeStateFile.
    index.ts        # Re-exports (including ModelDef from providers/types).
  tools/
    registry.ts     # ToolRegistry: register, get, list.
    execute.ts      # executeToolCalls: ordering (mutating sequential, read-only
                    # concurrent), result assembly.
    fileTools.ts    # read_file, write_file, edit_file.
    commands.ts     # run_command, check_command.
    search.ts       # search (text + glob modes).
    webTools.ts     # fetch_webpage.
    finish.ts       # finish tool.
    spawnSubagent.ts# makeSpawnSubagentTool, SubagentRunner type.
    metaTools.ts    # search_tools, call_tool (dynamic tool surface).
    skills.ts       # list_skills, read_skill, appendSkillIndex.
    catalog.ts      # Tool catalog for dynamic tool surface.
    names.ts        # Tool name constants.
    index.ts        # buildToolRegistry, appendSkillIndex, re-exports.
  context/
    compaction.ts   # Token accounting, recap/truncation.
  agent/
    loop.ts         # runTurn: the agent loop.
    session.ts      # createSession, session lifecycle.
    subagent.ts     # materializeProfile, makeSubagentRunner, AgentContext,
                    # SpawnerContext, SubagentRender, identitySection.
  server/
    protocol.ts     # Pure wire boundary: ServerEvent, ClientCommand, Scope,
                    # ConversationItem, UIState. No imports from agent/ or types/.
    translate.ts    # buildSnapshot, event translation.
    transport.ts    # WebSocket transport.
    server.ts       # AgentServer: session ownership, client management.
    entry.ts        # runServer: startup + server bootstrap.
  cli/
    args.ts         # Argument parsing.
    repl.ts         # REPL loop.
    commands.ts     # Slash commands.
    render.ts       # Terminal rendering.
    color.ts        # ANSI color helpers.
  cli.ts            # Executable entry: parse args, route serve/gui, start REPL.
  startup.ts        # prepareSession(): the shared startup seam.
  command.ts        # runCommand hook helper + runForeground.
  index.ts          # Side-effect-free public API.
```

### Dependency direction (must be acyclic)

```
types.ts  ←  utils.ts
   ↑
   ├── llm/errors.ts
   ├── llm/sse.ts  ←  llm/client.ts
   ├── hooks/types.ts  ←  hooks/manager.ts
   ├── providers/types.ts  ←  providers/llamaProvider.ts
   ├── profiles/types.ts  ←  profiles/registry.ts  ←  profiles/resolve.ts
   │                              ↑
   │                         profiles/validate.ts
   │                         profiles/load.ts
   │                         profiles/state.ts
   ├── tools/*  (all tool modules)
   ├── context/compaction.ts
   ├── agent/loop.ts  ←  agent/session.ts  ←  agent/subagent.ts
   ├── server/protocol.ts  (pure, no domain imports)
   ├── server/translate.ts  ←  server/server.ts  ←  server/entry.ts
   ├── cli/*
   ├── startup.ts
   └── index.ts
```

**Rule: `providers/types.ts` must not import from `profiles/`.**
`ModelDef` and `ResourceId` live in `src/types.ts` (core domain), so the
provider layer depends only on core types and hooks — never on the profile
layer. The profile layer depends on the provider layer (for `Provider` in the
`Registry` interface), but never the reverse.

### GUI

```
gui/
  src/
    main.tsx, App.tsx, store.ts, Markdown.tsx, client.ts, types.ts, styles.css
    conversation/
      ConversationViewport.tsx, viewModel.ts, eventQueue.ts
  e2e/
    conversation.perf.spec.ts, fixture.ts
```

The GUI is a SolidJS + Vite browser client. It mirrors `src/server/protocol.ts`
types by hand (`gui/src/types.ts`) and is never the source of truth. Bounded
conversation rendering: work is bounded by the window and changed rows, never
by history length.

---

## Potential Problems

1. **`src/tools/` exceeds the 10-file directory limit (13 files).**
   The tool modules are cohesive individually but the directory is too large.
   Candidate split: group file tools (`fileTools.ts`, `search.ts`) into a
   `tools/file/` subdirectory, or group web/meta tools into `tools/meta/`.
   The split must not introduce circular imports: tool modules depend on
   `tools/registry.ts` and `tools/execute.ts`, not on each other.

2. **`agent/subagent.ts` is the largest file in the codebase (330 code lines).**
   It contains `materializeProfile`, `makeSubagentRunner`, `AgentContext`,
   `SpawnerContext`, `SubagentRender`, `identitySection`, and several helpers.
   If it grows further, extract the runner into `agent/subagentRunner.ts` and
   the context/render types into `agent/agentContext.ts`.

3. **`server/server.ts` (415 code lines) is the second-largest file.**
   It owns session lifecycle, client management, and event routing. If the
   protocol grows, extract the client-management logic into
   `server/clientManager.ts`.

4. **`profiles/resolve.ts` (314 code lines) and `profiles/validate.ts`
   (390 code lines) are large.** They are cohesive (resolution and validation
   are distinct concerns) but should be watched. If either exceeds 500 code
   lines, split by concern (e.g., model resolution vs. profile resolution).

5. **The `Registry` interface in `profiles/types.ts` is the public API surface
   for config files.** It is large and will grow as new resource kinds or
   side-channels are added. If it exceeds ~50 methods, consider splitting into
   `Registry` (core graph ops) and `RegistryEx` (side-channels: providers,
   skills).

6. **Type-level coupling between `profiles/types.ts` and `providers/types.ts`
   is the primary structural risk.** The current cycle
   (`profiles/types.ts` → `providers/types.ts` → `profiles/types.ts`) is
   broken by keeping `ModelDef` and `ResourceId` in `src/types.ts`. Any new
   type that both layers need must go in `src/types.ts`, not in either
   layer's types file.

---

## Future Work

1. **Break the `profiles/types.ts` ↔ `providers/types.ts` cycle.**
   Move `ResourceId` and `ModelDef` from `profiles/types.ts` to `src/types.ts`.
   Update `providers/types.ts` to import `ModelDef` and `ResourceId` from
   `../types.js` instead of `../profiles/types.js`. Update `profiles/types.ts`
   to re-export `ResourceId` and `ModelDef` from `../types.js` for backward
   compatibility. Update `profiles/index.ts` to re-export `ModelDef` from
   `../providers/types.js`. This makes the dependency graph strictly
   one-directional: `profiles/` → `providers/` → `types.ts`.

2. **Split `src/tools/` to stay under the 10-file limit.**
   Group related tools into subdirectories: `tools/file/` (fileTools, search),
   `tools/meta/` (metaTools, catalog, names, skills), keeping `tools/registry.ts`,
   `tools/execute.ts`, `tools/index.ts`, `tools/finish.ts`, `tools/commands.ts`,
   `tools/spawnSubagent.ts`, `tools/webTools.ts` at the top level. This brings
   the top-level count to 7 files + 2 subdirectories.

3. **Extract the subagent runner from `agent/subagent.ts`.**
   Move `makeSubagentRunner` and its helpers into `agent/subagentRunner.ts`.
   Keep `materializeProfile`, `AgentContext`, `SpawnerContext`, and
   `SubagentRender` in `agent/subagent.ts` (or move them to
   `agent/agentContext.ts` if the file grows).

4. **Consider a `src/domain/` layer** if the codebase grows beyond ~30 modules.
   Currently `src/types.ts` is the core domain layer. If it grows beyond
   ~300 lines, split into `src/domain/message.ts`, `src/domain/tool.ts`,
   `src/domain/resource.ts`, `src/domain/config.ts`, etc.

5. **Protocol versioning.** The agent-server protocol is additive-only. If
   breaking changes become necessary, introduce a `protocolVersion` field in
   the `snapshot` event and a negotiation step on connect.

6. **Provider plugin system.** Providers are currently config-time conventions.
   If third-party providers become a use case, consider a `ProviderPlugin`
   interface with a discovery mechanism (e.g., `vise.providers` directory or
   a `providers` field in `.vise/index.ts`).

---

## Performance

- **LLM streaming:** The SSE parser (`llm/sse.ts`) accumulates tokens in a
  buffer and flushes on newline boundaries. For very long responses, the
  buffer grows linearly with response length. This is acceptable for typical
  LLM responses (< 100 KB) but would need chunked processing for very large
  outputs.

- **Tool execution:** Read-only tools run concurrently via `Promise.all`.
  For a large number of concurrent read-only calls (e.g., 20+ `read_file`
  calls), the concurrent I/O may saturate the event loop. A concurrency limit
  (e.g., `p-limit`-style batching) would be a future optimization.

- **Compaction:** Token accounting is O(n) in message count. For very long
  conversations (1000+ messages), the compaction pass may take noticeable
  time. A sliding-window token counter would be a future optimization.

- **GUI rendering:** Bounded by the virtual viewport — work is O(window +
  changed rows), not O(history). This is the correct design; no further
  optimization is needed unless the virtualizer itself becomes a bottleneck.

- **Subagent KV cache:** The llama.cpp KV save/restore around subagent runs
  is I/O-bound (file write + read). For deep subagent trees, the cumulative
  I/O may become significant. This is a provider concern, not a harness
  concern.

- **Config loading:** `loadViseConfig` reads and evaluates two TypeScript
  files (global + project). This is a one-time startup cost and is negligible
  relative to the first LLM call.
