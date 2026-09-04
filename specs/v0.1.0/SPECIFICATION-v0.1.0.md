# System Specification: Harness — Local Coding Agent

A TypeScript/Node command-line harness that runs a **single LLM coding agent** in a
tool-calling loop, backed by a local **llama.cpp** server. The agent reads, writes,
edits, and searches files and runs shell commands to complete software-engineering
tasks the user types into an interactive REPL.

---

## 1. Purpose and Scope

### 1.1 Purpose

Provide a minimal, self-contained agent runtime that:

- Talks to a local llama.cpp `llama-server` over its OpenAI-compatible
  `POST /v1/chat/completions` endpoint.
- Runs an agent loop: send messages → model returns text and/or tool calls →
  execute tools → append results → repeat.
- Terminates a turn only when the model calls the `finish` tool.
- Presents the work live in a terminal (streamed tokens + per-tool-call lines).

### 1.2 Stakeholders

- **Primary user:** a developer running the CLI on their own machine to get coding
  tasks done (refactors, bug fixes, scaffolding, running tests, etc.).
- **The LLM:** a local model served by llama.cpp that is capable of OpenAI-style
  tool calling (requires the server to be started with `--jinja`).

### 1.3 Success Criteria

- A user can start the REPL, type a coding task, and watch the agent use tools to
  accomplish it, ending with a clear final answer.
- The agent recovers from its own mistakes (bad tool args, failed commands) by
  reading the error back and retrying, without crashing the harness.
- Long conversations are compacted so they fit the model's context window.
- The harness has no hard dependency on any cloud provider; it works fully offline
  against a local llama.cpp server.

### 1.4 Out of Scope

- Full multi-agent orchestration: peer-to-peer agent networks, shared blackboards,
  or agents that communicate with each other directly. (A single parent agent
  delegating to short-lived, isolated **subagents** IS in scope — see §3.8.)
- A public HTTP API for the agent (CLI only).
- Sandboxing / permission system (trusted local use — see §8).
- Vision / multimodal inputs.
- Model management (downloading, quantizing, or launching the llama.cpp server is
  the user's responsibility; the harness only talks to an already-running server).

---

## 2. Domain Model

### 2.1 Entities

| Entity                | Description                                                       | Key Attributes                                                                                                                   |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Session**           | One REPL invocation. Holds the running conversation.              | `messages` (ordered list), `config`, `backgroundCommands` (map id → handle)                                                      |
| **Message**           | One entry in the conversation, in OpenAI chat format.             | `role` (`system` \| `user` \| `assistant` \| `tool`), `content`, optional `tool_calls`, optional `tool_call_id`, optional `name` |
| **ToolCall**          | A request from the model to run a tool.                           | `id`, `name`, `arguments` (JSON object)                                                                                          |
| **ToolResult**        | The outcome of executing a tool, fed back as a `tool` message.    | `tool_call_id`, `content` (string; success output or error text)                                                                 |
| **Tool**              | A callable capability exposed to the model.                       | `name`, JSON-schema `parameters`, handler                                                                                        |
| **BackgroundCommand** | A shell command running asynchronously.                           | `id`, `status` (`running` \| `exited`), `exitCode?`, `stdout`, `stderr`                                                          |
| **Subagent**          | A short-lived, isolated agent spawned by `spawn_subagent` (§3.8). | `task`, `systemPrompt?`, `maxIterations`, `depth`, its own `messages`, its own background-command handles, `answer`              |
| **Config**            | Resolved runtime settings.                                        | see §6.1                                                                                                                         |

### 2.2 Relationships

- A **Session** has many **Messages** (ordered).
- An **assistant Message** may contain one or more **ToolCalls** (parallel tool calls
  are enabled).
- Each **ToolCall** produces exactly one **ToolResult**, appended as a `tool` Message
  with the matching `tool_call_id`.
- A **Session** owns a set of **BackgroundCommand** handles, keyed by id.
- A **Session** is configured by one resolved **Config**.
- A **Session** (the parent) may spawn zero or more **Subagent**s via the
  `spawn_subagent` tool. Each **Subagent** is itself a fresh, isolated conversation
  (its own `messages` array) and may in turn spawn further **Subagent**s, bounded by
  `maxSubagentDepth` (§3.8).
- Each **Subagent** owns its own set of **BackgroundCommand** handles, scoped to its
  lifetime and invisible to the parent.

### 2.3 State Transitions

**Agent turn (one user task):**

```
IDLE → THINKING (LLM call in flight)
THINKING → ACTING (model returned ≥1 tool call; executing tools)
ACTING → THINKING (tool results appended; next LLM call)
THINKING → DONE (model called finish; answer emitted)
THINKING → ABORTED (LLM/server error; see §4)
```

- `ACTING → THINKING` and `THINKING → ACTING` may repeat any number of times.
- There is **no iteration cap** (see §8, Assumptions — risk noted).
- After `DONE`, the REPL returns to `IDLE` for the next user task; the conversation
  history is retained.

**BackgroundCommand:**

```
running → exited
```

**Subagent (one `spawn_subagent` call):**

```
SPAWNED → RUNNING (fresh isolated session created; nested agent loop starts)
RUNNING → RUNNING (nested LLM call → tool execution → append results; repeats)
RUNNING → DONE (subagent called finish; answer returned as the spawn result)
RUNNING → CAP_REACHED (iteration cap hit; last text returned as the spawn result)
RUNNING → FAILED (subagent LLM/server error; error string returned as the spawn result)
```

- A **Subagent** runs the same agent loop as the parent (§3.2) on its own isolated
  session. Its `DONE` / `CAP_REACHED` / `FAILED` outcome is delivered to the parent
  as the `spawn_subagent` tool's result string; it never aborts the parent turn
  (§4, E18–E20).

---

## 3. Functional Requirements

### 3.1 User Actions (CLI)

| Action                     | Invocation                      | Effect                                                                |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Start REPL                 | `harness`                       | Launch interactive multi-turn REPL.                                   |
| Start REPL with first task | `harness "<task>"`              | Launch REPL and immediately run `<task>` as the first turn.           |
| Submit a task              | type text + Enter at the prompt | Begin an agent turn for that task.                                    |
| Show help                  | `/help`                         | List the available REPL commands.                                     |
| Show context usage         | `/context`                      | Print prompt tokens used on the last LLM call vs. the context window. |
| Quit                       | `/exit` (also `exit` / `quit`)  | End the session.                                                      |
| Use a config file          | `harness --config <path>`       | Load settings from `<path>` (default `./harness.config.json`).        |

The REPL is **multi-turn**: conversation history (messages) persists across turns so
the agent retains context from prior tasks.

### 3.2 The Agent Loop (core behavior)

For each user task, the harness MUST:

1. Append the user's task as a `user` Message.
2. Call the LLM (`POST /v1/chat/completions`) with:
   - the full `messages` array,
   - the `tools` array (the 8 tool definitions, §3.3; or the constant advertised
     surface when `dynamicTools` is set, §3.3.1),
   - `tool_choice: "auto"`,
   - `parallel_tool_calls: true`,
   - `stream: true`,
   - sampling params from Config (`temperature`, etc.).
3. **Stream** the response:
   - Emit assistant text tokens to the terminal as they arrive.
   - Accumulate any `tool_calls` from the streamed deltas.
4. On completion, inspect the final assistant message:
   - **If it contains tool call(s):** execute them (§3.4), append each result as a
     `tool` Message, and return to step 2.
   - **If it called `finish`:** emit the `answer` as the turn's final output, append
     the assistant message to history, and return to `IDLE`.
   - **If it has neither tool calls nor `finish`:** treat the text as the final
     answer (defensive fallback), emit it, and return to `IDLE`.
5. Before each LLM call, apply **context compaction** if needed (§3.5).

### 3.3 Tools

The harness exposes exactly these tools. All paths are resolved relative to the
process working directory unless absolute. All tool results are returned to the model
as **strings** (success output or a descriptive error).

| #   | Tool             | Parameters                                                                                                                                                                 | Returns                                                                                                                                                                                     |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `read_file`      | `path` (str, req); `startLine` (int, opt); `endLine` (int, opt)                                                                                                            | File content (or the requested line range). For binary files, a notice that the file is binary. If missing, an error string.                                                                |
| 2   | `write_file`     | `path` (str, req); `content` (str, req)                                                                                                                                    | Confirmation: path + bytes written. Creates parent directories as needed. Overwrites existing files.                                                                                        |
| 3   | `edit_file`      | `path` (str, req); `oldString` (str, req); `newString` (str, req); `replaceAll` (bool, opt, default `false`)                                                               | On success: confirmation of the edit. On failure: an error string stating the problem (e.g. `oldString not found`, or `oldString matched N times; pass replaceAll=true`).                   |
| 4   | `list_dir`       | `path` (str, req); `recursive` (bool, opt, default `false`)                                                                                                                | List of entries, each marked as file or directory.                                                                                                                                          |
| 5   | `search`         | `pattern` (str, req); `mode` (`"text"` \| `"glob"`, req); `path` (str, opt, default cwd); `includePattern` (str, opt); `isRegexp` (bool, opt, default `true` in text mode) | Text mode: matching `file:line:content` lines. Glob mode: matching file paths. Results truncated to `maxToolOutputChars` with a truncation notice.                                          |
| 6   | `run_command`    | `command` (str, req); `timeoutMs` (int, opt, default from Config); `background` (bool, opt, default `false`); `cwd` (str, opt)                                             | Foreground: `{ exitCode, stdout, stderr }` (each truncated to `maxToolOutputChars`). If the timeout elapses, the process is killed and the result is a timeout error. Background: `{ id }`. |
| 7   | `check_command`  | `id` (str, req)                                                                                                                                                            | `{ status: "running" \| "exited", exitCode?, stdout, stderr }` — output captured so far (truncated).                                                                                        |
| 8   | `finish`         | `answer` (str, req)                                                                                                                                                        | Terminal. Ends the current turn; `answer` is the final response to the user.                                                                                                                |
| 9   | `spawn_subagent` | `task` (str, req); `maxIterations` (int, req); `systemPrompt` (str, opt)                                                                                                   | Runs a fresh, isolated subagent (§3.8) on `task` and returns **only its final `finish` answer** as the result string. Multiple calls in one turn run concurrently.                          |

**Notes:**

- `run_command` uses the platform default shell (PowerShell on Windows, `sh`/`bash`
  on Unix) unless `Config.shell` overrides it.
- Tool execution order within a single turn: **mutating tools** (`write_file`,
  `edit_file`, `run_command`) are executed **sequentially** in the order the model
  gave them, to avoid file/command races. **Read-only tools** (`read_file`,
  `list_dir`, `search`, `check_command`) may run concurrently. Results are returned
  to the model in the same order as the original tool calls.
- **Delegation tools** (`spawn_subagent`) run **concurrently with each other** when
  the model issues several in one turn (each is an independent nested loop); this is
  a deliberate exception to the sequential-mutating rule, since subagents are
  independent and parallelism is the point (§3.8). The parent is responsible for not
  delegating conflicting file/command mutations to parallel subagents.

#### 3.3.1 Dynamic Tool Loading (optional, `dynamicTools`)

By default the harness advertises all 8 tools in the request's `tools` array. When
`Config.dynamicTools` is `true`, the harness instead advertises a **constant surface**
and exposes the rest of the catalog on demand. This keeps the request prefix stable
across turns so the server's KV cache stays warm (the `tools` array is part of the
prompt prefix; mutating it invalidates the shared prefix and forces full reprocessing).

- **Advertised surface (constant):** the core tools `read_file`, `write_file`,
  `edit_file`, `list_dir`, `search`, `finish`, plus two meta tools:
  - `search_tools` — `query` (str, req); `limit` (int, opt, default `5`). Returns the
    matching tool definitions (name, description, parameter schema) as a JSON string,
    ranked by token overlap (name matches weigh more than description matches).
  - `call_tool` — `name` (str, req); `args` (object, opt). Dispatches to any tool in
    the full catalog by name and returns its result string. Unknown names return an
    error string.
- **Catalog-as-data:** the full tool catalog is always present in the registry and
  dispatchable; only the _advertised_ set sent to the LLM is restricted. `call_tool`
  and `search_tools` resolve against the full catalog, so every tool remains reachable.
- **Caveat:** because tool definitions are appended to the conversation tail (not the
  prefix), a compaction that summarizes the tail can drop a previously discovered
  definition. The model can re-discover it with `search_tools`; this is acceptable
  because discovery is cheap and idempotent.

### 3.4 Tool Execution & Error Semantics

- Every tool call yields exactly one `tool` Message, even on failure.
- **Tool errors are returned to the model as the result string** (e.g. "file not
  found", "command exited with code 1: <stderr>"). The harness does **not** abort on
  tool errors; the model is expected to react and retry.
- **Malformed tool calls** (unknown tool name, invalid JSON arguments, or arguments
  that fail schema validation) produce a `tool` Message containing a descriptive
  error (e.g. `Unknown tool "foo"`, or `Invalid arguments for read_file: <path> is
required`). The model is expected to self-correct. The harness does not abort.
- Tool results and command outputs are truncated to `Config.maxToolOutputChars`
  (default 20,000 chars) with a notice, to protect the context window.

### 3.5 Context Compaction

- After each LLM call, the harness reads `usage.prompt_tokens` from the response.
- If `usage.prompt_tokens > Config.compactThreshold * Config.maxContext`
  (default `0.8 * maxContext`), the harness compacts **before the next LLM call**:
  1. Keep the `system` Message(s) and the most recent `Config.compactKeepMessages`
     Messages (default 6), trimmed to a boundary that keeps every assistant
     `tool_calls` Message paired with its `tool` result Message(s).
  2. Summarize all older Messages into a single recap by calling the LLM with a
     summarization prompt (e.g. "Summarize the work done so far, including files
     changed, commands run, and open issues, in a few bullet points.").
  3. Replace the message array with: `[system…, recap-as-user-message, …recent
Messages]`.
- Compaction is transparent to the user (a short "compacting context…" line may be
  printed).
- If the summarization LLM call fails, fall back to **truncation**: drop the oldest
  non-system, non-recent Messages (keeping tool-call/result pairs intact) rather than
  aborting.

### 3.6 CLI Output (live display)

While a turn runs, the terminal MUST show:

- **Streamed assistant text** tokens as they arrive.
- **One line per tool call**, e.g. `→ read_file(src/index.ts)`, followed by a
  condensed result line (e.g. `✓ 142 lines` or `✗ file not found`).
- The **final `finish` answer** clearly delimited at the end of the turn.

### 3.7 Workflows

**Happy path (single task):**

```
user: "Add input validation to the signup form"
  → LLM: read_file(src/signup.ts)
  → LLM: edit_file(src/signup.ts, …)
  → LLM: run_command("npm test")
  → LLM: finish("Added validation for email + password; all tests pass.")
REPL prompt returns.
```

**Follow-up turn (history retained):**

```
user: "Now make it reject duplicate emails"
  → agent already knows the file from the previous turn; edits + tests + finish.
```

**Recovery from a bad tool call:**

```
  → LLM: read_file()            [missing required path]
  → harness: tool result = "Invalid arguments for read_file: path is required"
  → LLM: read_file(src/signup.ts)   [self-corrected]
```

### 3.8 Subagents (delegation)

A **subagent** is a short-lived, isolated agent that the main agent spawns to
offload a subtask. Subagents exist for **context isolation** (a subtask's many tool
calls and large outputs stay out of the parent's context window), **parallelism**
(independent subtasks run at the same time), and **token savings** (the parent's
prompt stays small and stable). They are _not_ a role-specialization mechanism: a
subagent is the same agent runtime pointed at a narrower task.

#### 3.8.1 Invocation

The parent spawns a subagent by calling the `spawn_subagent` tool (§3.3, #9):

| Parameter       | Type   | Required | Meaning                                                                                      |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------------------- |
| `task`          | string | yes      | The subtask description / instructions for the subagent.                                     |
| `maxIterations` | int    | yes      | The subagent's iteration budget (see §3.8.4 for the cap rule).                               |
| `systemPrompt`  | string | no       | A tailored system prompt for this subagent. When omitted, a default subagent prompt is used. |

The tool is **blocking**: the parent's turn does not advance past the call until the
subagent reaches a terminal outcome. The tool's result string is **only the
subagent's final `finish` answer** (or an error/cap note — §3.8.5). Nothing else from
the subagent's conversation is returned to the parent.

#### 3.8.2 The subagent's runtime

Each `spawn_subagent` call creates a **fresh, isolated session** and runs the same
agent loop as the parent (§3.2) on it:

- **Conversation:** a new `messages` array containing only `[system, user-task]`.
  It does **not** inherit the parent's history.
- **System prompt:** the `systemPrompt` parameter if provided, otherwise a default
  subagent prompt (a concise worker persona: complete the given task with the
  provided tools; read before editing; verify with tests/builds when relevant;
  always call `finish` with a concise result).
- **Tools:** the same catalog as the parent, **including `spawn_subagent`** (so a
  subagent may spawn its own subagents), bounded by `maxSubagentDepth` (§3.8.4).
- **Compaction:** the same context-compaction logic as the parent (§3.5), applied to
  the subagent's own `messages` array using the same config thresholds.
- **Background commands:** the subagent gets its **own** background-command handles,
  scoped to its lifetime. The parent's `check_command` cannot see them; they are
  discarded when the subagent ends.
- **Termination:** the subagent ends when it calls `finish`, or when it reaches its
  iteration cap (§3.8.4).

#### 3.8.3 Concurrency

- When the model issues several `spawn_subagent` calls in a single assistant
  message, they run **concurrently** (each an independent nested loop). There is
  **no concurrency cap** — the number of parallel subagents is whatever the model
  requests in one batch.
- **Risk (accepted):** many concurrent subagents issue many concurrent LLM calls to
  a single local llama.cpp server, which may be slow or memory-pressured. This is
  accepted; the user can interrupt with Ctrl-C.

#### 3.8.4 Iteration cap and nesting depth

- **Iteration cap:** the subagent's effective iteration cap is
  `min(maxIterations, Config.subagentMaxIterations)`, where `maxIterations` is the
  required tool parameter and `Config.subagentMaxIterations` (default `50`) is a
  hard ceiling. This is defense in depth: the per-call budget is always bounded by
  the config ceiling.
- **Nesting depth:** the main agent is at depth `0`. A subagent at depth `N` may
  spawn a further subagent only if `N < Config.maxSubagentDepth` (default `3`).
  With the default, subagents may exist at depths 1, 2, and 3; a subagent at depth
  3 cannot spawn further. A `spawn_subagent` call that would exceed the depth limit
  returns an error result ("max subagent depth reached") instead of spawning.

#### 3.8.5 Outcomes returned to the parent

| Outcome       | Trigger                               | `spawn_subagent` result string                                                                 |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DONE`        | Subagent called `finish`              | The `finish` answer, verbatim.                                                                 |
| `CAP_REACHED` | Iteration cap hit with no `finish`    | The subagent's most recent assistant text, or a note ("iteration cap reached") if it has none. |
| `FAILED`      | Subagent LLM/server error (E3–E5)     | A descriptive error string (e.g. "subagent failed: cannot reach server").                      |
| `DEPTH`       | Spawn would exceed `maxSubagentDepth` | An error string ("max subagent depth reached").                                                |

In every case the result is a **string** fed back as a normal `tool` Message; the
parent turn **continues** (a subagent failure is _data_, not _control_ — see §4,
E18–E20 and the error-split invariant).

#### 3.8.6 CLI output

While a subagent runs, its streamed tokens and per-tool-call lines render **live and
indented** under the parent's `→ spawn_subagent(<task>)` line, so the user can watch
the subagent work. When the subagent ends, a single condensed result line is printed
(e.g. `✓ done (12 iters)` or `✗ failed`).

---

## 4. Edge Cases and Error Handling

| #   | Scenario                                                               | Required Behavior                                                                                                                                                |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Tool fails (file missing, command non-zero exit)                       | Return the error as the tool result; model reacts. No abort.                                                                                                     |
| E2  | Malformed tool call (bad JSON / unknown tool / bad params)             | Return a descriptive error as the tool result; model self-corrects. No abort.                                                                                    |
| E3  | llama.cpp server unreachable / connection refused                      | **Abort the turn immediately** with a clear message (e.g. "Cannot reach llama.cpp server at <baseUrl>. Is it running?"). No retries.                             |
| E4  | LLM request times out                                                  | **Abort the turn immediately** with a clear timeout message. No retries.                                                                                         |
| E5  | LLM returns an HTTP error (4xx/5xx) mid-loop                           | **Abort the turn immediately**, surfacing the status + body. No retries.                                                                                         |
| E6  | Conversation exceeds context window                                    | Compact per §3.5 before the next call.                                                                                                                           |
| E7  | Compaction summarization call fails                                    | Fall back to truncation (§3.5); do not abort.                                                                                                                    |
| E8  | Foreground command exceeds its timeout                                 | Kill the process; return a timeout error as the tool result.                                                                                                     |
| E9  | `check_command` with an unknown id                                     | Return an error result ("unknown command id").                                                                                                                   |
| E10 | Model never calls `finish` (loops on tools)                            | No cap by design (§8). The user can interrupt with Ctrl-C. Risk documented.                                                                                      |
| E11 | Model returns text with no tool calls and no `finish`                  | Treat the text as the final answer; end the turn.                                                                                                                |
| E12 | `edit_file` `oldString` matches 0 or >1 times (and `replaceAll` false) | Return an error result describing the match count; model adjusts.                                                                                                |
| E13 | `read_file` on a binary file                                           | Return a notice that the file is binary (do not dump bytes).                                                                                                     |
| E14 | Tool/command output exceeds `maxToolOutputChars`                       | Truncate and append a truncation notice.                                                                                                                         |
| E15 | User presses Ctrl-C during a turn                                      | Interrupt the current turn (kill any running foreground command), return to the REPL prompt.                                                                     |
| E16 | No model resolvable                                                    | If `model` is unset, query the running server's `GET /v1/models` and use the first loaded model. If that also yields nothing, print a clear setup hint and exit. |
| E17 | Config file present but invalid (bad JSON / unknown keys)              | Print a clear error naming the problem and exit (do not start the REPL).                                                                                         |
| E18 | A subagent's LLM/server call fails (server down, timeout, HTTP error)  | Return a descriptive error string as that `spawn_subagent` result; the parent turn **continues**. Other parallel subagents are unaffected.                       |
| E19 | A subagent hits its iteration cap without calling `finish`             | Return the subagent's most recent assistant text (or a cap note) as the `spawn_subagent` result; the parent turn continues.                                      |
| E20 | A `spawn_subagent` call would exceed `maxSubagentDepth`                | Return an error string ("max subagent depth reached") as the result; do not spawn. The parent turn continues.                                                    |
| E21 | A subagent runs a background command, then ends                        | The subagent's background-command handles are discarded with the subagent; the parent's `check_command` cannot reference them.                                   |

---

## 5. Non-Functional Requirements

- **Performance:**
  - First streamed token should appear promptly after the LLM begins generating
    (no artificial buffering of the stream).
  - Tool execution should not block the event loop (I/O and child processes are
    async).
- **Scalability:** Single-user, single-session, local. No concurrency requirements
  beyond async I/O within one process.
- **Security:**
  - Trusted local use. The harness runs real file operations and real shell commands
    with the user's privileges and performs **no sandboxing** (see §8).
  - If the llama.cpp server was started with `--api-key`, the harness sends it as a
    `Bearer` token from `Config.apiKey`.
  - Secrets (API key) are read from config/env, never logged.
- **Availability:** Local tool; no uptime SLA. Fails fast with clear messages when
  the server is down (§4, E3–E5).
- **Compatibility:**
  - Node.js **18+** (relies on global `fetch` and `node:child_process`).
  - Windows (PowerShell) and Unix (sh/bash).
- **Accessibility:** N/A (terminal application).
- **Reliability:** The harness must not crash on tool errors or malformed model
  output; only LLM/server connectivity errors abort a turn.

---

## 6. Data Requirements

### 6.1 Configuration

Resolved from, in priority order: \*\*CLI flags > environment variables > config file

> built-in defaults.\*\*

**Config file** (default `./harness.config.json`, override with `--config <path>`):
JSON is the primary format (no extra dependency). YAML is an optional extension if a
parser is available; JSON MUST always work.

| Key                     | Type           | Default                    | Env override                 | Description                                                                                          |
| ----------------------- | -------------- | -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `baseUrl`               | string         | `http://localhost:8080`    | `HARNESS_BASE_URL`           | llama.cpp server base URL.                                                                           |
| `model`                 | string         | _(none — auto-discovered)_ | `HARNESS_MODEL`              | Model name/id to request. If unset, the first model from the running server's `/v1/models` is used.  |
| `apiKey`                | string         | `""`                       | `HARNESS_API_KEY`            | Bearer token if the server uses `--api-key`.                                                         |
| `temperature`           | number         | `0.2`                      | `HARNESS_TEMPERATURE`        | Sampling temperature.                                                                                |
| `maxContext`            | number         | `8192`                     | `HARNESS_MAX_CONTEXT`        | Model context window in tokens (must match the served model).                                        |
| `compactThreshold`      | number         | `0.8`                      | `HARNESS_COMPACT_THRESHOLD`  | Fraction of `maxContext` at which compaction triggers.                                               |
| `compactKeepMessages`   | number         | `6`                        | `HARNESS_COMPACT_KEEP`       | Recent messages kept verbatim during compaction.                                                     |
| `commandTimeoutMs`      | number         | `60000`                    | `HARNESS_COMMAND_TIMEOUT_MS` | Default foreground command timeout.                                                                  |
| `maxToolOutputChars`    | number         | `20000`                    | `HARNESS_MAX_TOOL_OUTPUT`    | Truncation limit for tool/command output.                                                            |
| `systemPrompt`          | string \| null | built-in default           | `HARNESS_SYSTEM_PROMPT`      | Replaces the built-in system prompt if set.                                                          |
| `parallelToolCalls`     | boolean        | `true`                     | `HARNESS_PARALLEL_TOOLS`     | Enable parallel tool calls.                                                                          |
| `dynamicTools`          | boolean        | `false`                    | `HARNESS_DYNAMIC_TOOLS`      | Advertise a constant tool surface + `search_tools`/`call_tool` instead of the full catalog (§3.3.1). |
| `shell`                 | string         | `"auto"`                   | `HARNESS_SHELL`              | Shell for `run_command` (`auto`, `powershell`, `bash`, `sh`, or a path).                             |
| `maxIterations`         | number \| null | `null` (no cap)            | `HARNESS_MAX_ITERATIONS`     | Optional safety cap on tool-loop iterations per turn. `null` = no cap (default, per §8).             |
| `subagentMaxIterations` | number         | `50`                       | `HARNESS_SUBAGENT_MAX_ITER`  | Hard ceiling on a subagent's iteration budget; effective cap = `min(requested, this)` (§3.8.4).      |
| `maxSubagentDepth`      | number         | `3`                        | `HARNESS_MAX_SUBAGENT_DEPTH` | Maximum subagent nesting depth; a subagent at depth `N` may spawn only if `N < this` (§3.8.4).       |

**Built-in system prompt (default):** a concise coding-agent persona instructing the
model to: use the provided tools to accomplish the task; read before editing; run
tests/builds to verify; and **always call `finish` with a clear summary when the task
is complete**. `Config.systemPrompt`, when set, replaces this default.

### 6.2 Input Formats

- **User input:** free-form text typed at the REPL prompt (or the initial task arg).
- **LLM request:** OpenAI chat-completions JSON (`messages`, `tools`, `tool_choice`,
  `parallel_tool_calls`, `stream`, sampling params).
- **Tool arguments:** JSON objects validated against each tool's JSON schema.

### 6.3 Output Formats

- **Terminal:** streamed text + per-tool-call lines + final answer (§3.6).
- **LLM response:** OpenAI chat-completions (streamed SSE when `stream: true`),
  including `usage` token counts.
- **Tool results:** plain strings fed back as `tool` Messages.

### 6.4 Storage & Retention

- **No persistent storage.** The conversation and background-command handles live in
  memory for the duration of the session only. No transcript/log files are written
  (per requirement). On exit, all state is discarded.
- The only files the harness creates/edits are those the agent explicitly writes via
  `write_file`/`edit_file` as part of a task.

---

## 7. External Dependencies

| Dependency                   | Role                     | Notes                                                                                                                                                                            |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **llama.cpp `llama-server`** | The LLM backend.         | Must be running and started with `--jinja` for tool calling. Exposes OpenAI-compatible `POST /v1/chat/completions` (streaming via SSE). The harness does not start or manage it. |
| **Node.js runtime (18+)**    | Host runtime.            | Provides global `fetch`, `node:child_process`, `node:fs`, `node:path`.                                                                                                           |
| **Local filesystem**         | Target of file tools.    | Unrestricted access (trusted local use).                                                                                                                                         |
| **Local shell**              | Target of `run_command`. | PowerShell (Windows) / sh-bash (Unix), or `Config.shell`.                                                                                                                        |

**Runtime library guidance (keep minimal):**

- HTTP + SSE: use global `fetch` with a manual SSE line parser (no heavy SDK).
- Config: native `JSON.parse`; optional `js-yaml` only if YAML support is added.
- CLI args: `node:util` `parseArgs` (no dependency).
- No framework required.

---

## 8. Constraints and Assumptions

**Constraints**

- C1. The harness is a **CLI only**; it is not a library-first or HTTP service.
- C2. The LLM backend is **llama.cpp only** (OpenAI-compatible endpoint). No other
  providers are supported.
- C3. Tool calling requires the llama.cpp server to be started with `--jinja`; the
  served model must be capable of OpenAI-style tool calls.
- C4. **No sandboxing.** File and shell tools operate with the user's full local
  privileges. This is a deliberate choice for trusted local use.
- C5. **No iteration cap by default** (`maxIterations: null`). The loop is bounded
  only by the model calling `finish` or the user interrupting.
- C6. **No persistent state** across sessions.
- C7. **Subagents are isolated and ephemeral.** Each subagent runs in a fresh
  conversation, returns only its `finish` answer, and is discarded on completion.
  Subagents do not share state with the parent or with each other except through the
  parent's delegation of tasks and the returned answers (§3.8).
- C8. **Subagent failures are data, not control.** A subagent's LLM/server error,
  iteration-cap exhaustion, or depth-limit breach is returned as a `spawn_subagent`
  result string and never aborts the parent turn (§4, E18–E20).

**Assumptions**

- A1. The user runs the harness on their own machine and trusts the agent with local
  file and shell access.
- A2. The user is responsible for starting a compatible llama.cpp server and choosing
  a model with a context window matching `maxContext`.
- A3. The working directory at launch is the project the agent should operate on.

**Risk (documented, accepted):**

- R1. With no iteration cap (C5), a weak or looping model could run tools
  indefinitely. Mitigations available: the user can Ctrl-C at any time, and the
  optional `maxIterations` config flag can impose a cap if desired. This is accepted
  per the explicit requirement to trust the `finish` tool.

---

## 9. Acceptance Criteria

The implementation is correct when all of the following hold:

1. **Startup:** `harness` with a reachable server and valid config starts the REPL
   and shows a prompt. With no `model` configured, it auto-discovers the first model
   from the running server's `/v1/models`; only if discovery also fails does it print a
   setup hint and exit.
2. **Happy path:** Given a task, the agent calls tools, streams text, prints a line
   per tool call, and ends by printing the `finish` answer; the REPL returns to the
   prompt.
3. **Multi-turn:** A second task in the same session has access to the first turn's
   file/context (history retained).
4. **Tool correctness:**
   - `read_file` returns content; `write_file` creates/overwrites; `edit_file` edits
     exactly the matched text and errors on 0 or >1 matches (without `replaceAll`);
     `list_dir` lists entries; `search` returns text and glob matches; `run_command`
     returns exit code + stdout/stderr.
5. **Self-correction:** A malformed tool call (e.g. missing required arg) does not
   crash the harness; the error is returned and the model can retry.
6. **Tool failure:** A failing command (non-zero exit) returns the error to the model
   without aborting the turn.
7. **Server down:** If the server is unreachable, the turn aborts immediately with a
   clear message (no retries, no crash).
8. **Compaction:** When `usage.prompt_tokens` exceeds `compactThreshold * maxContext`,
   older messages are summarized and the turn continues successfully within the
   context window.
9. **Timeout:** A foreground command exceeding its timeout is killed and a timeout
   error is returned as the tool result.
10. **Background commands:** `run_command(background: true)` returns an id;
    `check_command(id)` reports running/exited status and output.
11. **Parallel tool calls:** When the model returns multiple tool calls in one turn,
    all are executed (mutating ones serialized) and all results are returned in order.
12. **Config precedence:** A value set via env var overrides the config file; a CLI
    flag overrides both.
13. **No persistence:** After exit, no transcript/log files are created by the
    harness.
14. **Subagent delegation:** `spawn_subagent(task, maxIterations)` runs an isolated
    subagent and returns only its `finish` answer as the result string. Multiple
    `spawn_subagent` calls in one turn run concurrently.
15. **Subagent isolation:** A subagent's conversation, background-command handles,
    and compaction are independent of the parent's; only the final answer crosses the
    boundary.
16. **Subagent bounds:** A subagent's effective iteration cap is
    `min(maxIterations, subagentMaxIterations)`; a `spawn_subagent` call that would
    exceed `maxSubagentDepth` returns an error result instead of spawning.
17. **Subagent failure is non-fatal:** A subagent LLM/server error, iteration-cap
    exhaustion, or depth breach returns an error/result string and the parent turn
    continues (it does not abort).

---

## 10. Open Questions

_(None — all requirements resolved. Defaults chosen for unspecified details are
documented inline in §3.5, §6.1, and §8.)_
