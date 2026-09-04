# Harness

A local, self-contained LLM coding-agent harness. It runs a single coding agent in a
tool-calling loop against a [llama.cpp](https://github.com/ggml-org/llama.cpp) server's
OpenAI-compatible `POST /v1/chat/completions` endpoint, letting the model read, write,
edit, search, and run commands to complete software-engineering tasks in an interactive
REPL.

There are **no runtime dependencies** — only Node's built-in modules (`fetch`,
`node:child_process`, `node:fs`, `node:path`, `node:util`, `node:readline`).

## Prerequisites

- **Node.js 18+** (or [Bun](https://bun.sh) for development).
- A **running llama.cpp server** with tool-calling enabled. Start it with the `--jinja`
  flag so the model's chat template emits tool calls:

  ```bash
  llama-server -m your-model.gguf --jinja --port 8080
  ```

  Confirm it is up:

  ```bash
  curl http://localhost:8080/v1/models
  ```

## Install & Build

```bash
bun install        # or: npm install
bun run build      # compiles TypeScript to dist/
```

## Run

```bash
# Development (runs the TypeScript source directly):
bun run dev

# Production (runs the compiled output):
bun run start

# Pass an initial task as a positional argument (run as the first turn):
bun run dev "add a retry helper to src/utils.ts"

# Or, after `npm link` / installing the package:
harness "your task"
```

At the `harness> ` prompt, type a task and press Enter. Type `exit` or `quit` to leave.
Press `Ctrl-C` during a turn to abort it (any running foreground command is killed).

## Scripts

| Script              | Description                             |
| ------------------- | --------------------------------------- |
| `bun run build`     | Compile TypeScript to `dist/`           |
| `bun run dev`       | Run the agent from source               |
| `bun run start`     | Run the compiled agent                  |
| `bun test`          | Run the test suite (unit + integration) |
| `bun run lint`      | Lint with ESLint                        |
| `bun run lint:fix`  | Lint and auto-fix                       |
| `bun run typecheck` | Type-check without emitting             |

## Configuration

Settings are resolved with the precedence **flags > env > file > defaults**.

Create an optional `harness.config.json` in the working directory (or point to one with
`--config <path>`):

```json
{
  "model": "your-model-name",
  "baseUrl": "http://localhost:8080",
  "temperature": 0.2,
  "maxContext": 8192
}
```

`model` is optional: if it is not set via flag, env, or file, the harness queries
the running llama.cpp server (`GET /v1/models`) and uses the first loaded model.
Only set it explicitly when you need to pick among several loaded models.

### Keys

| Key                   | Type           | Default                  | Env var                      | Description                                                                           |
| --------------------- | -------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------- |
| `baseUrl`             | string         | `http://localhost:8080`  | `HARNESS_BASE_URL`           | LLM server base URL.                                                                  |
| `model`               | string         | `null` (auto-discovered) | `HARNESS_MODEL`              | Model name. If unset, the first model from the running server's `/v1/models` is used. |
| `apiKey`              | string         | `""`                     | `HARNESS_API_KEY`            | Bearer token (optional).                                                              |
| `temperature`         | number         | `0.2`                    | `HARNESS_TEMPERATURE`        | Sampling temperature.                                                                 |
| `maxContext`          | number         | `8192`                   | `HARNESS_MAX_CONTEXT`        | Context window size in tokens.                                                        |
| `compactThreshold`    | number (0, 1]  | `0.8`                    | `HARNESS_COMPACT_THRESHOLD`  | Fraction of `maxContext` that triggers compaction.                                    |
| `compactKeepMessages` | number         | `6`                      | `HARNESS_COMPACT_KEEP`       | Recent messages kept verbatim during compaction.                                      |
| `commandTimeoutMs`    | number         | `60000`                  | `HARNESS_COMMAND_TIMEOUT_MS` | Default foreground command timeout.                                                   |
| `maxToolOutputChars`  | number         | `20000`                  | `HARNESS_MAX_TOOL_OUTPUT`    | Truncation limit for tool output.                                                     |
| `systemPrompt`        | string \| null | `null` (built-in)        | `HARNESS_SYSTEM_PROMPT`      | Override the system prompt.                                                           |
| `parallelToolCalls`   | boolean        | `true`                   | `HARNESS_PARALLEL_TOOLS`     | Allow the model to batch tool calls.                                                  |
| `dynamicTools`        | boolean        | `false`                  | `HARNESS_DYNAMIC_TOOLS`      | Advertise a constant tool surface + `search_tools`/`call_tool` instead of the full catalog (spec §3.3.1). |
| `shell`               | string         | `"auto"`                 | `HARNESS_SHELL`              | `auto`, `powershell`, `bash`, or `sh`.                                                |
| `maxIterations`       | number \| null | `null`                   | `HARNESS_MAX_ITERATIONS`     | Cap on tool-call iterations per turn.                                                 |

### CLI flags

```
--config <path>        Path to a config file (default ./harness.config.json)
--model <name>         Model name (overrides config/env)
--base-url <url>       LLM server base URL
--temperature <n>      Sampling temperature
--max-context <n>      Context window size in tokens
--max-iterations <n>   Cap on tool-call iterations per turn
-h, --help             Show help
```

## Tools

The agent exposes eight tools:

| Tool            | Mutating | Parameters                                                                  | Description                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `read_file`     | no       | `path`, `startLine?`, `endLine?`                                            | Read a file, optionally a 1-based line range.                                 |
| `write_file`    | yes      | `path`, `content`                                                           | Write a file, creating parent directories.                                    |
| `edit_file`     | yes      | `path`, `oldString`, `newString`, `replaceAll?`                             | Replace an exact string; errors on 0 or >1 matches unless `replaceAll`.       |
| `list_dir`      | no       | `path`, `recursive?`                                                        | List directory entries with file/dir markers.                                 |
| `search`        | no       | `pattern`, `mode` (`text`\|`glob`), `path?`, `includePattern?`, `isRegexp?` | Search file contents (`file:line:content`) or file paths.                     |
| `run_command`   | yes      | `command`, `timeoutMs?`, `background?`, `cwd?`                              | Run a shell command (foreground by default; `background=true` returns an id). |
| `check_command` | no       | `id`                                                                        | Check the status/output of a background command.                              |
| `finish`        | no       | `answer`                                                                    | Terminal tool: ends the turn with a final answer.                             |

**Execution ordering:** mutating tools (`write_file`, `edit_file`, `run_command`) run
sequentially in model order; read-only tools run concurrently. Results are always returned
to the model in the original tool-call order.

**Error semantics:** tool errors and malformed calls are returned to the model as result
strings (the agent can self-correct); only LLM/server connectivity errors abort the turn.

## Testing

`bun test` runs the full suite (unit + integration). Integration tests drive the real
agent loop against a mock OpenAI-compatible SSE server, so no llama.cpp instance is
required.

### Acceptance-criteria → test mapping (spec §9)

| AC                         | Covered by test                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------- |
| 1. Startup / setup hint    | `cli.test.ts` (setup hint + non-zero exit), `discover.test.ts` (model auto-discovery) |
| 2. Happy path              | `integration.test.ts` (finish directly; tool round-trip)                              |
| 3. Multi-turn history      | `integration.test.ts` (history retained)                                              |
| 4. Tool correctness        | `tools.test.ts` (file/search tools), `commands.test.ts`                               |
| 5. Self-correction         | `integration.test.ts` (bad args fed back), `tools.test.ts` (dispatch)                 |
| 6. Tool failure (no abort) | `integration.test.ts` (tool failure), `tools.test.ts` (dispatch)                      |
| 7. Server-down abort       | `integration.test.ts` (server-down)                                                   |
| 8. Compaction              | `compaction.test.ts` (trigger, boundary pairing, truncation)                          |
| 9. Command timeout         | `commands.test.ts` (foreground timeout)                                               |
| 10. Background commands    | `commands.test.ts` (background + check + killAll)                                     |
| 11. Parallel tool calls    | `sse.test.ts` (multi tool-call accumulation), `tools.test.ts` (ordering)              |
| 12. Config precedence      | `config.test.ts` (defaults/env/flags, coercion)                                       |
| 13. No persistence         | `cli.test.ts` (in-memory session, no config file created)                             |

## Troubleshooting

- **"No model configured"** — the harness could not find a model to use. Either
  start a llama.cpp server with a model loaded (it is auto-discovered via
  `/v1/models`), or set `model` explicitly via `--model`, `HARNESS_MODEL`, or
  `harness.config.json`.
- **Server not reachable** — confirm `curl http://localhost:8080/v1/models` works and that
  `baseUrl` matches.
- **Model never calls tools** — the model must be served with `--jinja` so its chat
  template supports tool calling, and it must be a tool-capable model.
- **Tool calls malformed** — some smaller models emit tool-call JSON that does not parse;
  the harness feeds the error back so the model can retry, but a stronger model helps.
