# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

**Vise** is a local, self-contained LLM coding-agent harness. It runs a coding agent in a
tool-calling loop against any OpenAI-compatible `POST /v1/chat/completions` endpoint
(llama.cpp, OpenRouter, Ollama, vLLM, …). Everything the agent can do — system prompt,
tools, lifecycle hooks, models — is described by TypeScript config files as a graph of
**resources** connected by **edges**.

## Runtime & build

- **Runtime: Bun 1.3+.** Both the harness and its config files execute TypeScript
  directly from source. **There is no build step and no Node runtime.**
- **No runtime dependencies.** Only Node built-ins: `fetch`, `node:child_process`,
  `node:fs`, `node:path`, `node:util`, `node:readline`, `node:os`.
- `src/cli.ts` is the executable entry (`bin: vise`). `src/index.ts` is the
  side-effect-free public API that `.vise/index.ts` imports.

## Commands

| Command               | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `bun run dev`         | Run the agent from source (`src/cli.ts`)       |
| `bun run start`       | Same as `dev`                                  |
| `bun test`            | Run the full suite (unit + integration)        |
| `bun run lint`        | Lint with ESLint                               |
| `bun run lint:fix`    | Lint and auto-fix                              |
| `bun run typecheck`   | Type-check without emitting (`tsc --noEmit`)   |

Run `bun run typecheck` and `bun test` after making changes. Integration tests drive the
real agent loop against a mock OpenAI-compatible SSE server, so no llama.cpp instance is
required.

## TypeScript / lint conventions

- `tsconfig.json`: `strict`, `module: NodeNext`, `moduleResolution: NodeNext`,
  `noEmit`, `target: ES2022`.
- **Import specifiers use the `.js` extension** even though the source files are `.ts`
  (e.g. `import { x } from "./utils.js"`). This is required by `NodeNext` resolution.
  Do not "fix" these to `.ts` — they are correct.
- ESLint uses `typescript-eslint` recommended. `no-explicit-any` is **off**;
  `no-unused-vars` is a **warn** with `^_` prefix ignored.

## Directory layout

```
src/
  cli.ts            # Executable entry: parse args, resolve config, start REPL
  index.ts          # Side-effect-free public API (types + LlamaProvider)
  types.ts          # Core domain types (Message, ToolCall, Tool, Config, Session, …)
  utils.ts          # truncate, resolvePath, resolveShell, looksBinary, newId, homeDir
  agent/            # loop.ts (runTurn), session.ts, subagent.ts
  llm/              # client.ts, sse.ts (stream parser), errors.ts
  tools/            # registry, dispatch, execute (ordering), fileTools, commands,
                    # search, finish, spawnSubagent, metaTools, catalog, names
  context/          # compaction.ts (token accounting + recap/truncation)
  hooks/            # manager.ts, types.ts, index.ts (lifecycle dispatch)
  profiles/         # registry, load, resolve, validate, state, defaults, types
  providers/        # llamaProvider.ts, types.ts, index.ts
  cli/              # args, repl, commands, render, color
test/               # *.test.ts (unit + integration), helpers.ts
specs/              # v0.1.0/, v0.2.0/, v0.3.0/ — the specification documents
.vise/              # project-level config (index.ts) + state.json (gitignored)
```

## Architecture: the resource graph

Configuration is a graph. **Resources are nodes; connections are directed edges.**
Resolving a profile means following its outgoing edges.

- **Edge types (only these are valid):** Profile→Hook, Profile→Tool, Profile→Model,
  Hook→Tool. Any other pairing is a fatal config error.
- **Defaults from absence of edges:**
  - Profile with **no tool edges** → gets **every** built-in tool. With tool edges →
    exactly those. A profile that enumerates tools **must** include `finish`, or it is a
    fatal config error.
  - Profile with **no hook edges** → no hooks. Hooks are never global.
  - Profile with **no model edge** → sees every model allowed by its `models` whitelist.

`ResourceId` is opaque — it only comes from a `create*` call, a `get*` lookup, or
`reg.builtins`, so a connection can never point at something that doesn't exist. A `get*`
lookup can return `undefined`; passing that into `createConnection` without checking is a
descriptive error.

## Key invariants (do not break)

- **Error semantics:** tool errors and malformed calls are returned to the model as
  **result strings** (the agent self-corrects). Only LLM/server connectivity errors
  (`LLMError`) abort the turn. Never throw a tool error up to the loop.
- **Tool execution ordering:** mutating tools (`write_file`, `edit_file`, `run_command`)
  run **sequentially** in model order; read-only tools run **concurrently**. Results are
  always returned in the **original tool-call order**. A blocked call still occupies its
  slot. The one exception: `spawn_subagent` is read-only (concurrent) *unless* the active
  model's provider sets `serializeSubagents` — KV persistence needs one subagent at a
  time (KV spec §3.7).
- **`finish` is terminal** unless a `turn:end` hook rejects it; a rejection becomes the
  finish call's tool result and the loop continues so the model can retry.
- **Hooks are synchronous only**, except `subagent:before` / `subagent:after`, whose
  handlers may be async and are awaited by `HookManager.dispatchAsync` (KV spec §8.1).
  On the other seven events a returned Promise is an unsupported result (a warning).
  A handler that throws blocks the event (or becomes advisory on a non-blocking event),
  is logged to stderr, and does not stop the remaining hooks.
- **Hooks are per-profile**, except those a **provider** contributes via `Provider.hooks()`:
  those are merged into every session at every depth (KV spec §8.2). Providers are still
  config-time conventions, not graph nodes.
- **`src/index.ts` must stay side-effect-free.** Importing it from `.vise/index.ts` must
  never launch a session or touch stdin.

## Testing

- `bun test` runs everything. Tests live in `test/*.test.ts` with shared `helpers.ts`.
- Integration tests spin up a **mock OpenAI-compatible SSE server** (fixture responses)
  and drive the full agent loop — no real model needed.
- The README maps each acceptance criterion (spec §9) to a specific test file. When adding
  behavior, add or extend the corresponding test.

## Gotchas

- **No provider → fatal at startup.** A config must register at least one provider
  (e.g. `reg.addProvider(new LlamaProvider({ url: "http://localhost:8080" }))`), or Vise
  exits with "No models available". There is no built-in default model.
- **Config conflicts are fatal:** a profile/model/tool defined with the same name in both
  `~/.vise/index.ts` and `./.vise/index.ts` is a "Config conflict" error. Hooks have no
  name and never conflict.
- **`setRuntime` merges per key** (project file wins over global, which wins over
  built-in defaults).
- **State file** (`.vise/state.json` or `~/.vise/state.json`) is per-user session state,
  not config — it is gitignored. A bad/missing state file never blocks startup; Vise
  warns and falls back to the built-in `Agent` profile.
- **The name `Agent` is reserved** for the implicit built-in profile; a config file cannot
  define a profile by that name.
- **Relative imports in config files use the `.ts` extension** (Bun accepts either, but
  Node's type stripping does not rewrite `.js` back to `.ts`). This is distinct from the
  `.js` convention used inside `src/`.

## Reference

- `README.md` — full user-facing docs: config reference, Registry API, providers, tools,
  hooks, profiles, troubleshooting.
- `specs/v0.1.0/`, `specs/v0.2.0/`, `specs/v0.3.0/` — the specification documents (the
  source of truth for behavior and acceptance criteria).
- `WBS.md` — work breakdown structure and acceptance-criteria traceability.
