# Work Breakdown Structure — Harness (Local Coding Agent)

Deliverable-oriented breakdown of the project defined in `SPECIFICATION.md`.
Each **work package (WP)** is a unit of work small enough to estimate and assign.
IDs are hierarchical: `1` = project, `1.1` = deliverable, `1.1.1` = work package,
`1.1.1.a` = task.

**Legend:** `[F]` foundation · `[C]` core · `[I]` integration · `[Q]` quality

---

## 1. Harness

### 1.1 Foundation & Scaffolding `[F]`

The buildable skeleton everything else compiles against.

- **1.1.1 Project setup**
  - a. Initialize `package.json` (name, `bin` entry `harness`, scripts: `build`, `dev`, `test`, `start`).
  - b. `tsconfig.json` (Node 18 target, `ES2022`, strict, `module: NodeNext` or `ESNext` + bundler).
  - c. Choose build tool (e.g. `tsc` or `tsup`) and output layout (`dist/`).
  - d. Source layout: `src/{config,llm,tools,agent,context,cli}/`, `src/index.ts` entry.
  - e. Lint/format config (ESLint + Prettier) and `.gitignore`.
- **1.1.2 Shared types & utilities**
  - a. Core types: `Message`, `ToolCall`, `ToolResult`, `Tool`, `BackgroundCommand`, `Config`, `Session` (mirror §2 of spec).
  - b. Small utils: string truncation, path resolution, platform shell detection.

### 1.2 Configuration `[F]`

- **1.2.1 Config schema & defaults**
  - a. Define the `Config` interface and built-in defaults (table in spec §6.1).
  - b. Built-in default system prompt (coding-agent persona, §6.1).
- **1.2.2 Config resolution**
  - a. Load JSON config file (default `./harness.config.json`, `--config` override).
  - b. Read env-var overrides (`HARNESS_*`).
  - c. Parse CLI flags (`node:util` `parseArgs`).
  - d. Apply precedence: **flags > env > file > defaults**.
- **1.2.3 Config validation**
  - a. Validate types/ranges; detect unknown keys.
  - b. Missing `model` → setup hint + exit (E16).
  - c. Invalid file → clear error naming the problem + exit (E17).

### 1.3 LLM Client `[C]`

Talks to llama.cpp's OpenAI-compatible endpoint.

- **1.3.1 Request builder**
  - a. Build `/v1/chat/completions` payload: `messages`, `tools`, `tool_choice:"auto"`, `parallel_tool_calls`, `stream:true`, sampling params.
  - b. Attach `Authorization: Bearer` when `apiKey` set.
- **1.3.2 SSE stream parser**
  - a. Parse `text/event-stream` deltas from `fetch` response body.
  - b. Accumulate assistant text tokens (emit for streaming).
  - c. Accumulate `tool_calls` across deltas (by index), reconstruct final `arguments` JSON.
  - d. Capture `usage` (prompt/completion tokens) from the final chunk.
- **1.3.3 Error handling (abort semantics, §4 E3–E5)**
  - a. Connection refused / unreachable → throw `ServerUnreachableError` (no retry).
  - b. Request timeout → throw `LLMTimeoutError` (no retry).
  - c. HTTP 4xx/5xx → throw `LLMHttpError` with status + body (no retry).

### 1.4 Tool System `[C]`

- **1.4.1 Tool registry & dispatch**
  - a. `Tool` interface: `name`, JSON-schema `parameters`, async `handler(args) → string`.
  - b. Registry mapping name → tool; expose OpenAI `tools` array for the LLM.
  - c. Dispatch: validate args against schema; unknown tool / bad args → descriptive error string (E2), never throw to the loop.
- **1.4.2 Result handling**
  - a. Truncate any result to `maxToolOutputChars` + notice (E14).
  - b. Wrap handler exceptions into error result strings (E1).
- **1.4.3 Execution ordering (§3.3)**
  - a. Classify tools as mutating vs read-only.
  - b. Run mutating tools sequentially in model order; read-only tools concurrently.
  - c. Return results to the model in original tool-call order.
- **1.4.4 File tools**
  - a. `read_file` (line range, binary notice E13, missing-file error E1).
  - b. `write_file` (create parents, overwrite, report bytes).
  - c. `edit_file` (exact match; 0 or >1 matches → error E12; `replaceAll`).
  - d. `list_dir` (file/dir markers, optional recursive).
- **1.4.5 Search tool**
  - a. `search` text mode (regex/literal, `file:line:content`, `includePattern`).
  - b. `search` glob mode (filename matching).
  - c. Result truncation.
- **1.4.6 Command tools**
  - a. `run_command` foreground (shell, `cwd`, timeout → kill + timeout error E8).
  - b. `run_command` background (spawn, return `id`).
  - c. `check_command` (status/exitCode/output; unknown id → error E9).
  - d. **Background command manager**: in-memory map id → handle; capture stdout/stderr; track exit.
- **1.4.7 Finish tool**
  - a. `finish(answer)` — terminal tool; signals end of turn.

### 1.5 Agent Loop `[C]`

- **1.5.1 Core loop (§3.2)**
  - a. Append user task; call LLM; stream; inspect result.
  - b. Tool-call branch: execute tools, append `tool` results, loop.
  - c. `finish` branch: emit answer, append assistant message, return to IDLE.
  - d. Fallback branch: text with no tools/finish → treat as final answer (E11).
- **1.5.2 Self-correction & safety**
  - a. Feed malformed-call errors back as tool results (E2) — no abort.
  - b. Optional `maxIterations` cap (default null; if set, stop at cap) (E10, R1).
  - c. Propagate LLM/server abort errors up to the CLI (E3–E5).

### 1.6 Context Management `[C]`

- **1.6.1 Token accounting**
  - a. Read `usage.prompt_tokens` after each call.
  - b. Compare against `compactThreshold * maxContext`.
- **1.6.2 Compaction (§3.5)**
  - a. Select boundary: keep system + last `compactKeepMessages`, preserving assistant `tool_calls` ↔ `tool` result pairing.
  - b. Summarize older messages via an LLM recap call.
  - c. Rebuild message array: `[system…, recap, …recent]`.
  - d. Fallback to truncation if the recap call fails (E7).

### 1.7 CLI / REPL `[I]`

- **1.7.1 Entry & startup**
  - a. `src/index.ts` → parse args, resolve config, validate, start REPL.
  - b. Optional initial task arg → run as first turn.
- **1.7.2 REPL loop**
  - a. Multi-turn prompt; retain conversation history across turns.
  - b. `exit`/`quit` handling.
- **1.7.3 Live output (§3.6)**
  - a. Stream assistant tokens to stdout.
  - b. One line per tool call (`→ name(args)`) + condensed result (`✓`/`✗`).
  - c. Clearly delimited final `finish` answer.
- **1.7.4 Interruption**
  - a. Ctrl-C during a turn → abort turn, kill running foreground command, return to prompt (E15).

### 1.8 Testing & Verification `[Q]`

- **1.8.1 Unit tests**
  - a. Config resolution & precedence (1.2).
  - b. SSE parser: token + tool-call accumulation, usage capture (1.3).
  - c. Each tool: happy path + error cases (1.4).
  - d. Execution ordering: mutating serial / read-only parallel, result order (1.4.3).
  - e. Compaction: trigger, boundary pairing, truncation fallback (1.6).
- **1.8.2 Integration tests**
  - a. Mock OpenAI-compatible server (fixture SSE responses) → drive the full agent loop.
  - b. Scenario: happy path, self-correction, tool failure, server-down abort.
- **1.8.3 Acceptance-criteria mapping**
  - a. Trace each of the 13 acceptance criteria (spec §9) to a test; ensure all covered.

### 1.9 Documentation `[Q]`

- **1.9.1 README**
  - a. Overview, prerequisites (Node 18+, running llama.cpp server with `--jinja`).
  - b. Install/build/run instructions.
  - c. Config reference (all keys, defaults, env vars, precedence).
  - d. Tool reference (the 8 tools + params).
  - e. Troubleshooting (server not reachable, model/tool-call setup).

---

## 2. Dependencies & Suggested Build Order

Critical path (each stage unblocks the next):

```
1.1 Foundation
   └─> 1.2 Config
         └─> 1.3 LLM Client ─┐
         └─> 1.4 Tools ──────┼─> 1.5 Agent Loop ─> 1.6 Context ─> 1.7 CLI/REPL
                              │
                              └────────────────────────────────────> 1.8 Tests (parallel, per component)
                                                                    1.9 Docs (last)
```

**Suggested sequence:**

1. **1.1** Foundation — buildable skeleton + types.
2. **1.2** Config — needed by everything.
3. **1.3** LLM Client and **1.4** Tools — independent of each other; can proceed in parallel.
4. **1.5** Agent Loop — composes 1.3 + 1.4.
5. **1.6** Context Management — plugs into the loop.
6. **1.7** CLI/REPL — user-facing shell around the loop.
7. **1.8** Tests — start unit tests alongside each component; integration tests after 1.5.
8. **1.9** Docs — finalize once behavior is stable.

**Parallelizable:** 1.3 ∥ 1.4; 1.8 (unit) ∥ all core work; 1.9 ∥ 1.8.

---

## 3. Traceability to Acceptance Criteria (spec §9)

| AC                         | Covered by WP                                   |
| -------------------------- | ----------------------------------------------- |
| 1. Startup / setup hint    | 1.2.3, 1.7.1                                    |
| 2. Happy path              | 1.5.1, 1.7.3                                    |
| 3. Multi-turn history      | 1.7.2                                           |
| 4. Tool correctness        | 1.4.4, 1.4.5, 1.4.6                             |
| 5. Self-correction         | 1.4.1, 1.5.2                                    |
| 6. Tool failure (no abort) | 1.4.2, 1.5.2                                    |
| 7. Server-down abort       | 1.3.3, 1.5.2                                    |
| 8. Compaction              | 1.6.2                                           |
| 9. Command timeout         | 1.4.6                                           |
| 10. Background commands    | 1.4.6                                           |
| 11. Parallel tool calls    | 1.3.1, 1.4.3                                    |
| 12. Config precedence      | 1.2.2                                           |
| 13. No persistence         | 1.7 (in-memory only), 1.4.6 (in-memory handles) |

---

## 4. Notes

- **No external runtime deps required** for the core (global `fetch`, `node:child_process`,
  `node:fs`, `node:path`, `node:util`). Optional `js-yaml` only if YAML config is added.
- **Testing strategy:** a mock OpenAI-compatible SSE server is the key enabler for
  integration tests without a real llama.cpp instance.
- **Risk R1 (no iteration cap):** mitigated in 1.5.2 via the optional `maxIterations`
  flag; verify with an integration test that a looping model is interruptible.
