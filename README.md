# Vise

A local, self-contained LLM coding-agent harness. It runs a coding agent in a
tool-calling loop against any OpenAI-compatible `POST /v1/chat/completions` endpoint —
[llama.cpp](https://github.com/ggml-org/llama.cpp), OpenRouter, Ollama, vLLM, or anything
else that speaks the same wire protocol — letting the model read, write, edit, search,
and run commands to complete software-engineering tasks in an interactive REPL.

Everything the agent can do — its system prompt, tools, lifecycle hooks, and models — is
described by TypeScript config files, as a graph of **resources** connected by **edges**.
A project-level `./.vise/index.ts` holds project-specific config; an optional
user-level `~/.vise/index.ts` holds defaults shared across every project. Both feed the
same graph. A config also registers one or more **providers** — a config-time convention
the harness queries at startup to discover the models a backend has loaded. Named
**profiles** group resources and (optionally) a whitelist of the models they may use, and
`/profile <name>` switches between them mid-session; the active profile and model are
remembered across restarts.

There are **no runtime dependencies** — only Node's built-in modules (`fetch`,
`node:child_process`, `node:fs`, `node:path`, `node:util`, `node:readline`).

## Prerequisites

- **[Bun](https://bun.sh) 1.3+**. Both the harness and its TypeScript configuration
  files execute directly from source; no compilation or Node runtime is required.
- A **running OpenAI-compatible LLM server** with tool-calling enabled, and at least one
  **provider** registered in `.vise/index.ts` (see [Providers](#providers) below) — with
  no provider registered, Vise exits with a fatal error at startup rather than guessing.
  For llama.cpp's `llama-server`, start it with `--jinja` so the model's chat template
  emits tool calls:

  ```bash
  llama-server -m your-model.gguf --jinja --port 8080
  ```

  Confirm it is up:

  ```bash
  curl http://localhost:8080/v1/models
  ```

## Install

```bash
bun install        # or: npm install
```

There is no build step. The package executes TypeScript directly (`src/cli.ts`), while
`src/index.ts` exports the side-effect-free public API for `.vise/index.ts`.

## Run

```bash
# Interactive REPL:
bun run dev

# Or using the start script:
bun run start

# Pass an initial task as a positional argument (run as the first turn):
bun run dev "add a retry helper to src/utils.ts"

# Or, after `npm link` / installing the package:
vise "your task"
```

At the `vise> ` prompt, type a task and press Enter. When a named profile is active the
prompt shows it: `vise:refactor> `. Type `/exit` (or `exit` / `quit`) to leave. Press
`Ctrl-C` during a turn to abort it (any running foreground command is killed).

| Command           | Effect                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`           | List the commands.                                                                                                                     |
| `/context`        | Prompt tokens from the last LLM call vs. the context window.                                                                           |
| `/clear`          | Clear the conversation (drops every exchange, keeps the system prompt).                                                                |
| `/profile`        | List the profiles (with origin: `builtin`/`global`/`project`), `*` marks the active one.                                               |
| `/profile <name>` | Switch profiles: prompt, tools, hooks, and model are all re-resolved. `/profile Agent` switches back to the implicit built-in profile. |
| `/model`          | List the models declared in `.vise/index.ts` (with origin), `*` marks the active one.                                                  |
| `/model <name>`   | Switch the active model, adopting its whole resource (`baseUrl`, `apiKey`, `temperature`, `maxContext`). The conversation is kept.     |
| `/skills`         | List the skills available to the agent (name + description).                                                                           |
| `/hooks`          | List the hooks active for the current profile.                                                                                         |
| `/hooks off\|on`  | Disable or re-enable every hook for the rest of the session.                                                                           |
| `/init`           | Create a `./.vise/index.ts` stub for this project (never overwrites an existing one).                                                  |
| `/init-global`    | Create a `~/.vise/index.ts` stub shared across every project (never overwrites an existing one).                                       |

## GUI

Vise also ships a browser-based GUI that drives the same session as the REPL. It is
served by a separate **agent-server** entry point (`vise serve` / `vise gui`) that
wraps the existing session machinery over a WebSocket.

```bash
# Start the GUI and open it in the browser:
bun run gui

# Or start the headless agent-server (prints its URL, does not open a browser):
bun run serve

# Override the port (default 8787):
bun run gui -- --port 9000

# Or, after `npm link` / installing the package:
vise gui
```

The server prints its URL (e.g. `Vise GUI: http://localhost:8787`) and keeps running
after the browser disconnects. The GUI and the REPL share the same session state
(active profile + model).

### Conversation rendering

The conversation is drawn through a **virtual viewport**: only the rows in view
(plus a small overscan, and whatever row holds keyboard focus) exist in the DOM.
Rendering work is therefore bounded by the window and by the rows that actually
changed, not by how long the conversation is — a streamed token updates one row
and leaves every other DOM node untouched.

The browser keeps the **whole** history it has received. Nothing is dropped,
there is no "last N messages" limit, and offscreen rows are not merely hidden
with CSS — they are simply not rendered until you scroll to them. Memory for the
retained history, and the cost of ingesting a reconnect snapshot, are still
proportional to the conversation's length; steady-state streaming is not.

Subagent output renders as a collapsible group. A run is open while it is
running and collapses when it finishes; expanding or collapsing one by hand
sticks until that run's state actually changes, and survives scrolling the group
out of view and back. Reasoning blocks behave the same way, and a collapsed
block does not render or parse its body at all.

> **Known limitation:** the browser's own find-in-page (`Ctrl`/`Cmd`+`F`) and
> select-all only see what is currently rendered, so they cover the visible part
> of the conversation rather than all of it. Full-history search and export are
> not part of this version.

### GUI development

```bash
# Agent-server + Vite dev server, in parallel:
bun run gui:dev

# From gui/ — type-check, build, and the browser tests:
bunx tsc --noEmit -p tsconfig.json
bun run build
bun run test:browser:install   # once: downloads Chromium for Playwright
bun run test:browser
```

The browser tests (`gui/e2e/*.spec.ts`) drive the real Vite app with a mock
WebSocket, and assert the rendering budget and the scroll/anchor/focus
behaviour. They are a separate runner from `bun test`: `bunfig.toml` confines
Bun's test discovery to `test/`, because Bun would otherwise collect
`*.spec.ts` too. A run writes a timing report to
`gui/e2e/report/conversation-perf.json`.

## Scripts

| Script              | Description                              |
| ------------------- | ---------------------------------------- |
| `bun run dev`       | Run the agent from source (`src/cli.ts`) |
| `bun run start`     | Run the agent from source (`src/cli.ts`) |
| `bun run gui`       | Start the GUI and open it in the browser |
| `bun run serve`     | Start the headless agent-server          |
| `bun run test`      | Run the test suite (unit + integration)  |
| `bun run lint`      | Lint with ESLint                         |
| `bun run lint:fix`  | Lint and auto-fix                        |
| `bun run typecheck` | Type-check without emitting              |

## Configuration

Configuration lives in up to two TypeScript files, each a module whose default export is
a function taking a `Registry`:

- **`~/.vise/index.ts`** (optional) — shared defaults: models, hooks, tools, and
  profiles you want available in every project.
- **`./.vise/index.ts`** (optional) — project-specific profiles, models, hooks, and
  tools.

Both are loaded into the **same graph** — the global file first, so the project file can
reference its resources by name (see [Cross-file references](#cross-file-references)).
There are no environment variables, no JSON config file, and no configuration flags. With
neither file present, Vise runs with built-in defaults: every built-in tool, no hooks,
and the built-in system prompt — but **no model**, since there is no built-in default and
no provider is registered. A config must register at least one [provider](#providers), or
Vise exits at startup with a fatal error.

If both files define a profile, model, or tool with the same name, Vise exits with a
fatal "Config conflict" error naming both files — rename or remove one. Hooks have no
name, so they never conflict; both files' hooks simply coexist in the graph.

```ts
// .vise/index.ts
import { LlamaProvider, type Registry } from "vise";

export default (reg: Registry) => {
  // Settings that are not resources.
  reg.setRuntime({ maxIterations: 40, commandTimeoutMs: 120_000 });

  // Discovers every model loaded on the server at startup (see Providers below).
  reg.addProvider(new LlamaProvider({ url: "http://localhost:8080" }));

  const implement = reg.createProfile({
    name: "default",
    systemPrompt: "You implement features end to end.",
    subagent: { profiles: ["review"], maxDepth: 2 },
  });

  const review = reg.createProfile({
    name: "review",
    systemPrompt: "You review code. You never modify files.",
  });

  const tests = reg.createHook({
    events: ["turn:end"],
    handler: (ctx) => runTests(ctx.cwd), // a string return blocks `finish`
  });

  // implement: every built-in tool, the test gate, whichever model is discovered.
  reg.createConnection(implement, tests);

  // review: read-only, no hooks.
  for (const tool of ["read_file", "list_dir", "search", "finish"] as const) {
    reg.createConnection(review, reg.builtins.tools[tool]);
  }
};
```

### The resource graph

Resources are **nodes**; connections are directed **edges**. Resolving a profile means
following its outgoing edges.

| Edge            | Meaning                                | Props                         |
| --------------- | -------------------------------------- | ----------------------------- |
| Profile → Hook  | The hook is active for this profile.   | —                             |
| Profile → Tool  | The tool is available to this profile. | —                             |
| Profile → Model | The profile uses this model.           | `temperature?`, `maxContext?` |
| Hook → Tool     | The hook only fires for these tools.   | —                             |

Any other pairing (Tool → Profile, Profile → Profile, …) is a fatal config error.

Two defaults follow from _absence_ of edges:

- A profile with **no tool edges** gets **every** built-in tool. One with tool edges
  gets exactly those (plus any custom tools it is connected to). Because the agent ends
  a turn by calling `finish`, a profile that enumerates its tools **must** include
  `reg.builtins.tools.finish`; omitting it is a fatal config error.
- A profile with **no hook edges** has **no** hooks. Hooks are never global.
- A profile with **no model edge** sees every model allowed by its `models` whitelist (see
  [Providers](#providers)) — every discovered/declared model when it has none. A
  `Profile → Model` connection pins one specific model instead, overriding that selection.

### Registry API

| Method                                                              | Returns                      | Description                                                                   |
| ------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `createProfile({ name, systemPrompt, subagent?, models? })`         | `ResourceId`                 | A named configuration. `systemPrompt: ""` means the built-in one.             |
| `createHook({ events, handler, includeSubagents? })`                | `ResourceId`                 | A lifecycle handler (see [Hooks](#hooks)).                                    |
| `createTool({ name, description, parameters, mutating, handler })`  | `ResourceId`                 | A custom tool.                                                                |
| `createModel({ name, baseUrl, apiKey, temperature?, maxContext? })` | `ResourceId`                 | An LLM endpoint declared directly, without a provider. Rarely needed.         |
| `addProvider(provider)`                                             | `ResourceId`                 | Register a provider (see [Providers](#providers)); discovered at startup.     |
| `createSkill(name, description, text)`                              | `void`                       | A skill — deferred context the agent loads on demand (see [Skills](#skills)). |
| `createConnection(from, to, props?)`                                | `void`                       | A directed edge.                                                              |
| `setRuntime(settings)`                                              | `void`                       | The settings that are not resources (below), including `profileSwitchMode`.   |
| `getProfile(name)`                                                  | `ResourceId \| undefined`    | Look up a profile (either file, or built-in) by name.                         |
| `getModel(name)`                                                    | `ResourceId \| undefined`    | Look up an explicitly `createModel()`-declared model by name.                 |
| `getTool(name)`                                                     | `ResourceId \| undefined`    | Look up a tool, built-in or custom, by name.                                  |
| `getProvider(name)`                                                 | `ResourceId \| undefined`    | Look up a registered provider by name.                                        |
| `builtins.tools`                                                    | `Record<string, ResourceId>` | Every built-in tool, keyed by name.                                           |
| `builtins.defaultProfile`                                           | `ResourceId`                 | The implicit `"Agent"` profile used when a profile has no explicit one.       |
| `builtins.providers`                                                | `Record<string, ResourceId>` | Every registered provider, keyed by name.                                     |

`ResourceId` is opaque: an id can only come from a `create*` call, a `get*` lookup, or
from `reg.builtins`, so a connection can never point at something that does not exist.
A `get*` lookup can return `undefined`; passing that straight into `createConnection`
without checking is rejected with a descriptive error rather than silently misbehaving.

#### Cross-file references

The project file runs _after_ the global file, against the same `Registry`, so it can
look resources up by name instead of importing paths:

```ts
// ~/.vise/index.ts (global)
export default (reg: Registry) => {
  reg.createModel({
    name: "local",
    baseUrl: "http://localhost:8080",
    apiKey: "",
  });
};

// ./.vise/index.ts (project)
export default (reg: Registry) => {
  const local = reg.getModel("local");
  if (!local) throw new Error("global model 'local' not found");

  const impl = reg.createProfile({ name: "implement", systemPrompt: "…" });
  reg.createConnection(impl, local);
};
```

There is no `getHook` — hooks have no name, so a project profile cannot connect to a
global hook. A hook defined in the global file is only active for the profiles _that
file itself_ connects it to.

The config is **composable** — any module that takes a `Registry` can contribute to the
same graph:

```ts
// .vise/index.ts
import { setup as lintHooks } from "./hooks/lint.ts";
import { setup as testHooks } from "./hooks/tests.ts";

export default (reg: Registry) => {
  lintHooks(reg, implement);
  testHooks(reg, implement);
  // …
};
```

Write those relative imports with the **`.ts`** extension. Bun accepts either form,
but Node's type stripping does not rewrite `.js` back to `.ts`, so `./hooks/lint.js`
fails to resolve there. (If you compile your config ahead of time and ship
`.vise/index.js`, use `.js` throughout as usual.)

### `setRuntime` settings

These are session-wide rather than per-profile, because they configure the agent loop
rather than the agent's capabilities.

| Setting                 | Type                      | Default     | Description                                                     |
| ----------------------- | ------------------------- | ----------- | --------------------------------------------------------------- |
| `compactThreshold`      | number (0, 1]             | `0.8`       | Fraction of the context window that triggers compaction.        |
| `compactKeepMessages`   | number                    | `6`         | Recent messages kept verbatim during compaction.                |
| `commandTimeoutMs`      | number                    | `60000`     | Default foreground command timeout.                             |
| `maxToolOutputChars`    | number                    | `20000`     | Truncation limit for tool output.                               |
| `parallelToolCalls`     | boolean                   | `true`      | Allow the model to batch tool calls.                            |
| `shell`                 | string                    | `"auto"`    | `auto`, `powershell`, `bash`, or `sh`.                          |
| `maxIterations`         | number \| null            | `null`      | Cap on tool-call iterations per turn.                           |
| `dynamicTools`          | boolean                   | `false`     | Advertise a constant tool surface + `search_tools`/`call_tool`. |
| `subagentMaxIterations` | number                    | `50`        | Ceiling on a subagent's iteration budget.                       |
| `maxSubagentDepth`      | number                    | `3`         | Depth backstop for profiles that set no `subagent.maxDepth`.    |
| `profileSwitchMode`     | `"replace"` \| `"append"` | `"replace"` | How `/profile` rewrites the system message.                     |

If both files call `setRuntime`, settings are merged **per key**, with the project
file's value winning over the global file's (which wins over the built-in default).

The model's own `temperature` and `maxContext` come from its `ModelDef`, overridable per
profile through connection props.

### Profiles

Exactly one profile is active at a time. Every session has an implicit built-in profile
named **`Agent`** — the built-in prompt, every built-in tool, no hooks, and (with no
`models` whitelist of its own) whichever model the active-model selection below picks.
The name `Agent` is reserved; a profile in either config file cannot use it.

A session starts under `Agent` **unless** a saved profile is restored from the state file
(see [Profile persistence](#profile-persistence) below) — naming a profile `default` no
longer selects it automatically.

`/profile <name>` re-resolves everything, including `/profile Agent` to switch back to
the implicit profile. **Conversation history is retained**; only the system message
changes, either replaced in place (the default) or appended to, per the `profileSwitchMode`
runtime setting. Switching takes effect between turns, never mid-turn.

### Profile persistence

On a clean exit (`/exit`, bare `exit`/`quit`, or Ctrl-D), Vise saves the active profile
name and model to a small state file, and restores it on the next start. Ctrl-C mid-turn
aborts the turn instead of exiting, so it never triggers a save.

The state file's location depends on whether a project config exists:

| Condition                    | State file           |
| ---------------------------- | -------------------- |
| `./.vise/index.ts` exists    | `./.vise/state.json` |
| `./.vise/index.ts` is absent | `~/.vise/state.json` |

It is per-user session state, not configuration — add it to your project's
`.gitignore`:

```gitignore
# .gitignore
.vise/state.json
```

If the saved profile no longer exists in the config, or the file is missing, corrupt, or
malformed, Vise warns on stderr and starts under `Agent` instead — it never refuses to
start over a bad state file. The saved model name also pins the active-model selection on
restart (and on every later `/profile` switch), so the same model is used even if a
provider's model list has since changed — as long as a model with that name is still in
the profile's available set.

### Subagent policy

A profile's `subagent` field constrains the subagents it spawns:

```ts
reg.createProfile({
  name: "implement",
  systemPrompt: "…",
  subagent: {
    profiles: ["worker", "researcher"], // spawn_subagent may only name these
    maxDepth: 2, // reject a spawn when depth + 1 > 2
  },
});
```

`spawn_subagent` takes a required `profile` parameter. The subagent runs under
that profile — its own prompt, tools, hooks, and model. A disallowed name, a missing
`profile`, or a depth breach comes back as an
error _string_ the model can react to, never as a thrown exception.

Each profile's `maxDepth` governs the subagents **it** spawns, so a subagent running
under a profile with `maxDepth: 0` can spawn nothing. Omitting `maxDepth` falls back to
the global `maxSubagentDepth`.

### CLI flags

```
-h, --help   Show help
```

A task may be passed positionally and is run as the first turn. Any other flag is
rejected with a pointer to `./.vise/index.ts`.

## Providers

A **provider** is a config-time convention — not a graph node — that the harness queries
at startup to discover the models a backend has loaded. Register one or more with
`reg.addProvider()`; with none registered (or if every one discovers zero models), Vise
exits with a fatal error rather than falling back to anything.

```ts
import { LlamaProvider, type Registry } from "vise";

export default (reg: Registry) => {
  reg.addProvider(new LlamaProvider({ url: "http://localhost:8080" }));
};
```

- **`LlamaProvider`** is the built-in provider for an OpenAI-compatible llama.cpp server.
  It queries `GET {url}/v1/models` at startup and creates one `Model` resource per entry
  — including router mode, where one server serves several models.
- A **custom provider** is just an object with a `name` and an async `discoverModels()`
  returning `ModelDef[]`; it never needs to throw — an unreachable backend or an empty or
  malformed response should just resolve to `[]`, which Vise treats as "this provider
  found nothing" (a warning, not fatal, as long as some provider found something).
- **`name`** disambiguates providers in `models` whitelists and `/model` output; omit it
  and Vise assigns one (`llama_0`, `llama_1`, …). Two providers with the same name is a
  fatal config error.

### KV cache persistence across subagent calls

A subagent runs against the same llama.cpp slot as the agent that spawned it, evicting
that agent's KV cache — which it then has to re-prefill on its next turn. Opt in to
`kvPersistence` and the provider saves the spawning agent's prompt cache to disk before
every nested run and restores it afterwards, at every nesting depth:

```ts
reg.addProvider(
  new LlamaProvider({
    url: "http://localhost:8080",
    kvPersistence: true,
    slotSavePath: "C:/Users/me/AppData/Local/llama-slots",
  }),
);
```

Start the server with the same directory: `llama-server --jinja --slot-save-path
C:/Users/me/AppData/Local/llama-slots …`.

- **`slotSavePath` is required** when `kvPersistence` is true, and must be the directory
  the server was started with. Vise deletes the cache files itself (llama.cpp has no
  delete endpoint), so the server has to run on the same host. Omitting it is a fatal
  config error.
- **`slotId`** is the slot to save and restore; it defaults to `0`, the only slot on a
  single-slot server.
- **One file per depth.** The agent at depth _N_ owns `kv-depth-{N}.bin`: it writes the
  file on the way into a nested run and restores _and deletes_ it on the way out, so the
  files on disk are exactly the live ancestors of the running agent and nothing is left
  behind when the turn ends.
- **Fail-open.** A failed save (for instance HTTP 501, because the server was started
  without `--slot-save-path`) or a failed restore is a warning on stderr, never an
  aborted turn — the worst case is the re-prefill you had before. A save that failed is
  never followed by a restore.
- **Subagents are serialized** while this is on: with one slot and depth-keyed files,
  two `spawn_subagent` calls in one message would clobber each other, so they run one at
  a time instead of concurrently.
- **Requirements:** a single slot (`-np 1`, the default), a text-only model (slot save
  does not support multimodal), and `--swa-full` for an SWA model. Cache files are large
  (roughly 50 MB per 1K tokens), so give the volume headroom.

### Model selection

A profile's `models` field is a whitelist of the models it may use:

```ts
reg.createProfile({
  name: "cheap",
  systemPrompt: "…",
  models: ["openrouter", ["llama_0", "^qwen.*$"]],
});
```

- A bare provider name includes every model from that provider.
- A `[providerName, regex]` tuple includes only that provider's models whose name
  matches the regex (full-string match).
- Omitted or empty → every discovered/declared model is available.
- The active model is whichever the state file's `lastModel` names, if it's in the
  available set; otherwise the first one, in discovery order. A `Profile → Model`
  connection (still supported, mainly for a model declared directly via
  `reg.createModel()`) pins one model outright, overriding this selection — it must
  itself be in the whitelist, or the config is rejected.
- A subagent whose profile has no whitelist inherits the parent's exact active model
  (including its `baseUrl`, `apiKey`, `temperature`, and `maxContext`) rather than
  picking its own; one with a whitelist picks the first match, falling back to the
  parent's model (with a warning) if the whitelist matches nothing.

`/model` lists every discovered/declared model grouped by provider, the active one marked
`*`; `/model <name>` switches to it, or `/model <provider>/<name>` when the bare name is
ambiguous across providers.

## Tools

The agent exposes twelve built-in tools. A profile's Profile→Tool edges decide which
of them it actually sees — except `list_skills` and `read_skill`, which every profile
always gets, because skills are global to the session:

| Tool             | Mutating | Parameters                                                                  | Description                                                                    |
| ---------------- | -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `read_file`      | no       | `path`, `startLine?`, `endLine?`                                            | Read a file, optionally a 1-based line range.                                  |
| `write_file`     | yes      | `path`, `content`                                                           | Write a file, creating parent directories.                                     |
| `edit_file`      | yes      | `path`, `oldString`, `newString`, `replaceAll?`                             | Replace an exact string; errors on 0 or >1 matches unless `replaceAll`.        |
| `list_dir`       | no       | `path`, `recursive?`                                                        | List directory entries with file/dir markers.                                  |
| `search`         | no       | `pattern`, `mode` (`text`\|`glob`), `path?`, `includePattern?`, `isRegexp?` | Search file contents (`file:line:content`) or file paths.                      |
| `run_command`    | yes      | `command`, `timeoutMs?`, `background?`, `cwd?`                              | Run a shell command (foreground by default; `background=true` returns an id).  |
| `check_command`  | no       | `id`                                                                        | Check the status/output of a background command.                               |
| `fetch_webpage`  | no       | `url`                                                                       | Fetch a URL; returns inline text, a file path, a redirect notice, or an error. |
| `finish`         | no       | `answer`                                                                    | Terminal tool: ends the turn with a final answer.                              |
| `spawn_subagent` | no       | `task`, `maxIterations`, `systemPrompt?`, `profile`                        | Run an isolated subagent and return only its final answer.                     |
| `list_skills`    | no       | —                                                                           | List every skill (name + description). Always present.                         |
| `read_skill`     | no       | `name`                                                                      | Load one skill's full body, never truncated. Always present.                   |

Custom tools created with `reg.createTool()` are available only to the profiles they are
connected to.

**Execution ordering:** mutating tools (`write_file`, `edit_file`, `run_command`) run
sequentially in model order; read-only tools run concurrently. Results are always returned
to the model in the original tool-call order.

**Error semantics:** tool errors and malformed calls are returned to the model as result
strings (the agent can self-correct); only LLM/server connectivity errors abort the turn.

## Hooks

Hooks let you run your own code at the agent's lifecycle points — to **gate**
completion behind quality checks, or just to **observe** what the agent is doing.

A hook is a resource in the graph, created with `reg.createHook()` and connected to the
profiles it applies to:

```ts
// .vise/hooks/quality.ts
import { execSync } from "node:child_process";
import type { Hook, Registry, ResourceId } from "vise";

const hooks: Hook[] = [
  {
    // The agent cannot finish the turn until type-checking passes.
    events: ["turn:end"],
    handler: (ctx) => {
      try {
        execSync("npx tsc --noEmit", { cwd: ctx.cwd, stdio: "pipe" });
      } catch (err) {
        return String((err as { stdout?: Buffer }).stdout ?? err); // string -> block
      }
      // returning nothing -> allow
    },
  },
  {
    // Advisory only: the write still happens, the agent just sees the warnings.
    events: ["tool:after"],
    handler: (ctx) => {
      if (ctx.tool?.name !== "write_file") return;
      const warnings = lint(String(ctx.tool.args.path));
      if (warnings.length > 0)
        return { message: warnings.join("\n"), block: false };
    },
    includeSubagents: true, // also fires inside subagents
  },
];

/** Attach this file's hooks to `profile`. Called from .vise/index.ts. */
export const setup = (reg: Registry, profile: ResourceId) => {
  for (const hook of hooks) {
    reg.createConnection(profile, reg.createHook(hook));
  }
};
```

**Scoping a hook to particular tools.** A Hook→Tool edge restricts when the hook fires:

```ts
const guard = reg.createHook({
  events: ["tool:before"],
  handler: refuseMinified,
});
reg.createConnection(implement, guard); // active for `implement`
reg.createConnection(guard, reg.builtins.tools.write_file); // …but only on write_file
```

For `tool:before` / `tool:after` the hook fires only for the connected tools. Events
that carry no tool (`turn:end`, `session:start`, …) ignore the filter. A hook with no
tool edges fires for every tool.

### Events

| Event             | Fires when                                     | Can block? | Block effect                                |
| ----------------- | ---------------------------------------------- | ---------- | ------------------------------------------- |
| `tool:before`     | Just before a tool executes                    | **yes**    | Tool is not executed; message → tool result |
| `tool:after`      | Just after a tool completes (success or not)   | no         | —                                           |
| `turn:start`      | A new user task begins                         | no         | —                                           |
| `turn:end`        | The model calls `finish`                       | **yes**    | `finish` is rejected; message → tool result |
| `session:start`   | The REPL session is created                    | no         | —                                           |
| `session:end`     | The REPL session is torn down                  | no         | —                                           |
| `on:compaction`   | Just before context compaction runs            | no         | —                                           |
| `subagent:before` | Just before a spawned subagent starts running  | no         | —                                           |
| `subagent:after`  | Just after it finishes (done, cap, or failure) | no         | —                                           |

A block returned on a non-blocking event is downgraded to an advisory message.

`subagent:before` / `subagent:after` fire on the **spawning** agent's hooks, with
`ctx.depth` set to _its_ depth — the agent whose context is about to be interrupted —
and `subagent:after` fires from a `finally`, so it runs whatever the subagent did.

### Return values

| Return                     | Meaning                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| nothing (`void`)           | Allow. No message.                                                   |
| `"reason"`                 | Block, with the string as the reason.                                |
| `{ message, block: true }` | Block, with `message` as the reason.                                 |
| `{ message }`              | Advisory: `message` is injected as a system message; nothing blocks. |

When several hooks block the same event, the reasons are joined with `"; "`;
advisory messages are joined with newlines into one system message.

### Semantics

- **Synchronous only, with two exceptions.** Handlers must not return a Promise — use
  `execSync` and friends for shell work. `subagent:before` and `subagent:after` are the
  exception: their handlers may be async and are awaited, because the work they wrap (a
  KV save/restore round trip) is I/O. A Promise returned on any of the other seven
  events is logged as an unsupported result and ignored.
- **Observe, don't modify.** A hook can block an event or add a message; it cannot
  rewrite tool arguments, messages, or abort the turn.
- **Errors are contained.** A handler that throws blocks the event (or, on a
  non-blocking event, produces an advisory), is logged to stderr with its source
  file, and does not stop the remaining hooks from running.
- **Subagents opt in.** Hooks only fire inside a subagent when they set
  `includeSubagents: true`; `ctx.depth` is then greater than 0.
- **Per-profile, with one exception.** A hook is active only for the profiles it is
  connected to; a profile with no hook edges runs no hooks at all. The exception is a
  **provider**: one that implements `hooks()` contributes them to every session running
  against one of its models, at every depth (this is how `LlamaProvider` implements KV
  persistence). `/hooks` lists them with a `provider:<name>` source.
- **Fatal loading.** A malformed hook — no events, an unknown event, a missing handler —
  is a fatal config error at startup, reported alongside every other problem in the
  config.
- **Runtime toggle.** `/hooks` lists what is active for the current profile, `/hooks off`
  disables the system for the rest of the session, and `/hooks on` re-enables it. The
  toggle survives a profile switch.
- **Trust.** Hooks run in-process with Vise's privileges. There is no sandbox.

## Identity

Every system prompt ends with a short paragraph telling the model what it's actually
running as — Vise, on which model, via which provider, with what context window — so it
can answer "what are you?" or "what model are you?" from its own prompt instead of
guessing or claiming to be whichever model it happens to be talking to:

```
## Identity
You are Vise, a local coding-agent harness. You are running model "qwen-7b" via the
"llama" provider at http://localhost:8080, with a 32768-token context window.
```

It comes right after the profile's own prompt (or the built-in default) and before the
skill index, so every agent in the tree — main session and every subagent — carries it.
A model declared directly via `reg.createModel()`, with no provider behind it, drops the
`via "<name>" provider` clause.

## Skills

A **skill** is a named body of knowledge the agent loads _on demand_ — a library
reference, a domain procedure, a project convention. Putting all of that in the system
prompt would bloat every request and hurt KV-cache reuse even when it is irrelevant to
the task at hand. A skill splits the difference: only its name and one-line description
live in the system prompt, and the model pulls the body in when it decides the skill is
relevant.

```ts
// .vise/index.ts
import { readFileSync } from "node:fs";

export default (reg: Registry) => {
  reg.createSkill(
    "madge",
    "How to use the madge npm package for dependency analysis",
    readFileSync(".vise/skills/madge.md", "utf8"),
  );
};
```

The agent's system prompt then ends with a compact index — and nothing more:

```
## Available Skills
- madge: How to use the madge npm package for dependency analysis
- npm-deps: Managing npm dependencies in this project
```

The model reaches the bodies through two always-present tools: `list_skills` (names and
descriptions, for when the index has been compacted away) and `read_skill(name)`, which
returns the body verbatim. A skill body is **never truncated** to `maxToolOutputChars` —
it is the payload, not incidental tool output. Once read, it stays in the conversation
as an ordinary tool message and is subject to compaction like anything else.

**Semantics**

- **Global, not graph nodes.** Skills are a side-channel on the resource graph, like
  providers: no `ResourceId`, no edges, no per-profile scoping. Every profile and every
  subagent at every depth sees the same index and the same two tools.
- **Delegation.** Because subagents see the skills too, the main agent can spawn one
  with "read the `madge` skill and report the commands I need" and keep the body out of
  its own context entirely.
- **Unique names.** A duplicate skill name — in one file, or across `~/.vise/index.ts`
  and `./.vise/index.ts` — is a fatal config error, like a duplicate profile or model.
- **No skills is fine.** With none defined, the `## Available Skills` section is omitted
  from the system prompt and the two tools report that none are available.
- **Static for the session.** Skills are read once from the config at startup; there is
  no hot-reload, and the index is byte-stable, so it never invalidates the KV cache.
- **Opaque text.** Vise does not parse, validate, or size-limit a skill body. Keeping it
  small enough for the context window is the config author's job.

`/skills` lists them in the REPL.

## Testing

`bun test` runs the full suite (unit + integration). Integration tests drive the real
agent loop against a mock OpenAI-compatible SSE server, so no llama.cpp instance is
required.

### Acceptance-criteria → test mapping (spec §9)

| AC                         | Covered by test                                                                   |
| -------------------------- | --------------------------------------------------------------------------------- |
| 1. Startup / setup hint    | `cli.test.ts` (setup hint + non-zero exit), `providers.test.ts` (model discovery) |
| 2. Happy path              | `integration.test.ts` (finish directly; tool round-trip)                          |
| 3. Multi-turn history      | `integration.test.ts` (history retained)                                          |
| 4. Tool correctness        | `tools.test.ts` (file/search tools), `commands.test.ts`                           |
| 5. Self-correction         | `integration.test.ts` (bad args fed back), `tools.test.ts` (dispatch)             |
| 6. Tool failure (no abort) | `integration.test.ts` (tool failure), `tools.test.ts` (dispatch)                  |
| 7. Server-down abort       | `integration.test.ts` (server-down)                                               |
| 8. Compaction              | `compaction.test.ts` (trigger, boundary pairing, truncation)                      |
| 9. Command timeout         | `commands.test.ts` (foreground timeout)                                           |
| 10. Background commands    | `commands.test.ts` (background + check + killAll)                                 |
| 11. Parallel tool calls    | `sse.test.ts` (multi tool-call accumulation), `tools.test.ts` (ordering)          |
| 12. Configuration          | `profiles.test.ts` (loading, `setRuntime`, validation)                            |
| 13. No persistence         | `cli.test.ts` (in-memory session, no config file created)                         |

### fetch_webpage acceptance criteria (fetch spec §9)

| AC                                  | Covered by test                                                         |
| ----------------------------------- | ----------------------------------------------------------------------- |
| 1. Inline content + header          | `webTools.test.ts` (small text page, exact header format)               |
| 2. Large body to file path          | `webTools.test.ts` (70,000-byte body, file round-trip)                  |
| 3. PDF to file path                 | `webTools.test.ts` (application/pdf bytes round-trip)                   |
| 4. 301 to redirect notice           | `webTools.test.ts` (301 with Location)                                  |
| 5. 404 to error line                | `webTools.test.ts` (exact `[error: HTTP 404: Not Found]`)               |
| 6. Unreachable host to error string | `webTools.test.ts` (connection refused, no throw)                       |
| 7. Empty URL to error line          | `webTools.test.ts` (exact `[error: empty URL]`)                         |
| 8. Redirects never followed         | `webTools.test.ts` (server sees exactly one request)                    |
| 9. 30-second timeout                | `webTools.test.ts` (short-timeout build, slow stream)                   |
| 10. TLS verification enforced       | `webTools.test.ts` (TLS error classification; no insecure flag in code) |

### Hooks acceptance criteria (hooks spec §9)

| AC                        | Covered by test                                                           |
| ------------------------- | ------------------------------------------------------------------------- |
| 1. Blocking `turn:end`    | `hooks.test.ts` (finish rejected, agent retries; `maxIterations` honored) |
| 2. Blocking `tool:before` | `hooks.test.ts` (a `*.min.js` write is never executed)                    |
| 3. Advisory `tool:after`  | `hooks.test.ts` (warning follows the tool result; the write stands)       |
| 4. Handler throws         | `hooks.test.ts` (blocks, is logged, other hooks still run)                |
| 5. `/hooks` on/off        | `hooks.test.ts` (listing, toggle, dispatch suppressed while off)          |
| 6. `includeSubagents`     | `hooks.test.ts` (depth filtering; subagent finish blocked then allowed)   |
| 7. Zero overhead unhooked | `hooks.test.ts` (inert manager, no file loading, loop unchanged)          |
| 8. Malformed hook         | `hooks.test.ts` (fatal config error for bad events/handlers)              |

### Profiles acceptance criteria (profiles spec §9)

| AC                                 | Covered by test                                                  |
| ---------------------------------- | ---------------------------------------------------------------- |
| 1. Two profiles, starts on default | `profiles.test.ts` (session starts under `default`)              |
| 2. `/profile` lists both           | `profiles.test.ts` (active marked with `*`)                      |
| 3. `/profile <name>` switches      | `profiles.test.ts` (prompt, tool set, and model all change)      |
| 4. Hook scoped to one profile      | `profiles.test.ts` (fires under `default`, not under `refactor`) |
| 5. Hook→Tool filtering             | `profiles.test.ts` (fires for `write_file`, not `read_file`)     |
| 6. No tool edges → all tools       | `profiles.test.ts` (every built-in tool)                         |
| 7. Tool edges → only those         | `profiles.test.ts` (`read_file` + `search` + `finish`)           |
| 8. No config → built-in defaults   | `profiles.test.ts` (empty project resolves to the defaults)      |
| 9. Config throws → fatal           | `profiles.test.ts` (`ViseConfigError` carrying the message)      |
| 10. `/profile nonexistent`         | `profiles.test.ts` (error text, no switch)                       |
| 11. Composable config              | `profiles.test.ts` (`.vise/index.ts` importing `.vise/hooks/…`)  |
| 12. Connection prop override       | `profiles.test.ts` (per-profile `temperature`)                   |
| 13. Subagent under a profile       | `profiles.test.ts` (subagent runs with the researcher prompt)    |
| 14. Forbidden profile              | `profiles.test.ts` (error listing the allowed profiles)          |
| 15. Depth limit                    | `profiles.test.ts` (depth 1 succeeds, depth 2 refused)           |
| 16. No `profile` param             | `profiles.test.ts` (missing `profile` is rejected)               |
| 17. `maxDepth: 0`                  | `profiles.test.ts` (spawning always refused)                     |

### Providers acceptance criteria (providers spec §9)

| AC                                  | Covered by test                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| P1. Discovery incl. router mode     | `providers.test.ts` (`LlamaProvider` against a mock `/v1/models`)            |
| P2. `models` whitelist filters      | `providers.test.ts` (string and `[provider, regex]` elements)                |
| P3. No whitelist → all models       | `providers.test.ts` (first wins, `lastModel` pins another)                   |
| P4. Subagent inherits parent model  | `providers.test.ts` (exact `baseUrl`/`apiKey`/`temperature`/`maxContext`)    |
| P5. No provider → fatal             | `cli.test.ts` ("No models available", non-zero exit)                         |
| P6. Same name, two providers        | `providers.test.ts` (ambiguous bare name, `<provider>/<name>` disambiguates) |
| P7. Provider interface is general   | `providers.test.ts` (a plain object literal, no concrete class)              |
| P8. No built-in default model       | `profiles.test.ts` (no provider/model → `config.model` is `null`)            |
| P9. `reg.createModel()` still works | `profiles.test.ts`, `providers.test.ts` (explicit model via a connection)    |
| P10. `LLMClient` unchanged          | (structural — the agent loop only ever sees the resolved `Config`)           |

### KV persistence acceptance criteria (KV spec §9)

| AC                            | Covered by test                                                            |
| ----------------------------- | -------------------------------------------------------------------------- |
| 1. Opt-in is inert by default | `kvPersistence.test.ts` (no hooks, no `/slots` traffic, session unhooked)  |
| 2. Save on subagent start     | `kvPersistence.test.ts` (`save` of `kv-depth-0.bin` before the nested run) |
| 3. Restore on subagent end    | `kvPersistence.test.ts` (`restore` then `unlink` of the same file)         |
| 4. Restore on failure         | `kvPersistence.test.ts` (LLM error and iteration cap both restore)         |
| 5. Every level                | `kvPersistence.test.ts` (depth 0 → 1 → 2 saves/restores in stack order)    |
| 6. Disk clean at turn end     | `kvPersistence.test.ts` (no `kv-depth-*.bin` left in `slotSavePath`)       |
| 7. Fail-open save             | `kvPersistence.test.ts` (HTTP 501 and an unreachable server: warn, go on)  |
| 8. Fail-open restore          | `kvPersistence.test.ts` (HTTP 500 on restore: warn, turn unaffected)       |
| 9. Serialization              | `kvPersistence.test.ts` (`mutating` flip; overlap 1 vs. 2 in one batch)    |
| 10. Config validation         | `kvPersistence.test.ts` (missing `slotSavePath` throws)                    |
| 11. Async events only there   | `kvPersistence.test.ts` (awaited on subagent events, warned on the rest)   |
| 12. Integration               | `kvPersistence.test.ts` (mock SSE + `/slots` server, main → sub → main)    |

### Skills acceptance criteria (skills spec §9)

| AC                            | Covered by test                                                         |
| ----------------------------- | ----------------------------------------------------------------------- |
| 1. `createSkill` stores it    | `skills.test.ts` (store keyed by name; not a graph node)                |
| 2. Empty name                 | `skills.test.ts` ("Skill name must be non-empty.")                      |
| 3. Duplicate in one file      | `skills.test.ts` (fatal, names the duplicate)                           |
| 4. Duplicate across files     | `skills.test.ts` (two-tier load → "Config conflict")                    |
| 5. Index in the system prompt | `skills.test.ts` (`## Available Skills`, bodies excluded)               |
| 6. No skills → no section     | `skills.test.ts` (header absent; `appendSkillIndex` is a no-op)         |
| 7. Creation order             | `skills.test.ts` (global first, then project)                           |
| 8/13. Always registered       | `skills.test.ts` (default _and_ tool-enumerating profiles)              |
| 9. `list_skills` output       | `skills.test.ts` (one `name: description` per line)                     |
| 10. `list_skills` empty       | `skills.test.ts` ("No skills available.")                               |
| 11/18. Read-only              | `skills.test.ts` (`mutating: false` on both)                            |
| 12/19. Dynamic-tools surface  | `skills.test.ts` (both advertised; both in `CORE_TOOL_NAMES`)           |
| 14. `read_skill` body         | `skills.test.ts` (full text returned)                                   |
| 15. No truncation             | `skills.test.ts` (5 KB body under a 100-char cap; a normal tool is cut) |
| 16. Unknown skill             | `skills.test.ts` (lists what is available; empty-store variant)         |
| 17. Empty name                | `skills.test.ts` (result string, turn not aborted)                      |
| 20–22. Subagent visibility    | `skills.test.ts` (same index, both tools, body loaded in the subagent)  |
| 23. `/skills` listing         | `skills.test.ts` (name + description, dispatched by the REPL)           |
| 24. `/skills` with none       | `skills.test.ts` ("No skills defined.")                                 |
| 25. Backward compatibility    | `skills.test.ts` (no index, tools present, "no skills" messages)        |

## Troubleshooting

- **KV cache files pile up in `--slot-save-path`** — a `kv-depth-*.bin` left behind means
  a restore failed (the warning is on stderr); it is overwritten by the next run at that
  depth and is safe to delete by hand.
- **"No models available"** — no provider is registered, or every registered provider
  discovered zero models. Register one in `.vise/index.ts` (e.g.
  `reg.addProvider(new LlamaProvider({ url: "http://localhost:8080" }))`) and make sure
  its server is running with a model loaded.
- **"Invalid .vise configuration"** — the config built a graph that cannot run. The
  message lists every problem at once: duplicate names, invalid edges, a profile that
  enumerates tools without `finish`, an out-of-range `setRuntime` value, an unknown
  provider in a `models` whitelist.
- **Server not reachable** — confirm `curl http://localhost:8080/v1/models` works and that
  the provider's `url` matches.
- **Model never calls tools** — the model must be served with `--jinja` (for llama.cpp) so
  its chat template supports tool calling, and it must be a tool-capable model.
- **Tool calls malformed** — some smaller models emit tool-call JSON that does not parse;
  Vise feeds the error back so the model can retry, but a stronger model helps.
- **A tool the model needs is missing** — check the active profile's Profile→Tool edges
  with `/profile`; a profile that enumerates any tools gets only those.
- **Every keystroke shows up doubled at the prompt** (`test` renders as `tteesstt`) — seen
  running under `bun run` on Windows (any shell, including a plain PowerShell console),
  and also under MSYS2/mintty-based shells (Git Bash) on any runtime. Neither honors
  Node's raw-mode request, so the console's own echo doubles up with `readline`'s. Vise
  detects both and disables its own terminal handling there, relying on the console's
  native echo instead — if you still see it, run `node dist/index.js` (`npm run build &&
npm start`) instead of `bun run`, or from Windows Terminal/PowerShell/cmd.exe directly.
