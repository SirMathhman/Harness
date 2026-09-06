# System Specification: `ask_questions` Tool

**Version:** 0.7.0
**Date:** 2026-02-26
**Builds on:** v0.6.0 (subagent lifecycle hooks & command runner)

---

## 1. Purpose and Scope

### 1.1 Purpose

Add a new built-in tool, **`ask_questions`**, that lets the agent **pause its
turn and ask the human user a small batch of structured questions**, then
continue with the user's answers. This is the first Vise tool that is not a
pure function of its arguments: it must reach the human and block until a reply
arrives.

The tool supports three question modes:

- **single** — the user picks exactly one option from a list.
- **multiple** — the user picks one or more options from a list.
- **free** — the user types anything (no options).

A choice question (single/multiple) **also** always allows a free-text answer in
addition to the options, so the user is never forced into a choice that does not
fit.

**Primary use case:** the agent is about to make a decision with several
reasonable alternatives (e.g. "which of these three approaches do you want?",
"which files should I touch?") and wants the user's input rather than guessing.

**Stakeholders:**

- **The user** (REPL or GUI), who answers the questions.
- **The model**, which calls the tool and receives the answers as a tool result.
- **The Vise runtime**, which threads a new *user-input channel* through the
  session so the tool can reach the human on whichever surface is active.

### 1.2 Success criteria

- In the **REPL**, the agent can call `ask_questions`, the user is prompted for
  each question in turn, and the answers are returned to the model as a tool
  result.
- In the **GUI**, the agent can call `ask_questions`, the browser renders a form,
  the user submits it, and the answers are returned to the model.
- A **subagent** can call `ask_questions`; the request is presented to the
  top-level user (indented / scoped to the subagent) and the answer returns to
  the subagent.
- When **no human is available** (headless run, test, no terminal/browser), the
  tool is still present but returns a clear "user unavailable — make your best
  decision" result string, so the model can proceed.
- The existing REPL and GUI continue to work unchanged when the tool is not
  called.

### 1.3 Explicitly out of scope (this version)

- **Timeouts.** Waiting for an answer has no wall-clock limit (confirmed).
- **Editing/re-asking.** Once a batch is answered, the agent cannot "go back" to
  it; it may issue a new `ask_questions` call if it needs more input.
- **Rich option metadata** (descriptions, icons, previews per option). Options
  are plain strings.

---

## 2. Domain Model

### 2.1 New Entities

#### `Question`

One question in an `ask_questions` batch.

| Field      | Type                          | Required | Description                                                                 |
| ---------- | ----------------------------- | -------- | --------------------------------------------------------------------------- |
| `id`       | `string`                      | Yes      | Stable key for the answer. Must be unique within the batch.                  |
| `text`     | `string`                      | Yes      | The question prompt shown to the user.                                       |
| `options`  | `string[]`                    | No       | The choices. Present for a choice question; absent for a free question.      |
| `select`   | `"single" \| "multiple"`      | No       | How many options may be chosen. Default `"single"`. Only meaningful when `options` is present. |

A question **with** `options` is a *choice* question (single or multiple). A
question **without** `options` is a *free* question.

#### `QuestionAnswer`

The user's answer to one question.

| Field      | Type         | Description                                                              |
| ---------- | ------------ | ------------------------------------------------------------------------ |
| `selected` | `string[]`   | The options the user chose (in the order presented). Empty for a free question or when the user chose none. |
| `text`     | `string`     | Free text the user typed. Empty when none. Present for any mode.         |

#### `AskResult`

The outcome of one `ask_questions` call.

| Field     | Type                                        | Description                                                        |
| --------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `status`  | `"answered" \| "cancelled"`                 | `answered` when the user submitted; `cancelled` when the turn was aborted while waiting. |
| `answers` | `Record<string, QuestionAnswer>`            | Keyed by question `id`. Empty when `status` is `cancelled`.        |

`Question`, `QuestionAnswer`, and `AskResult` are **type exports** from the
package root (`src/index.ts`).

#### `UserInputChannel`

The abstraction that lets a tool reach the human. This is the "channel" — the
plumbing that (a) presents the questions and (b) hands the answers back.

```ts
interface UserInputChannel {
  /**
   * Present `questions` to the user and resolve with their answers.
   * `scope.depth` is the depth of the agent asking (0 = main agent), used for
   * indentation (REPL) and scope correlation (GUI).
   *
   * **Multiple `ask` calls may be pending concurrently.** `spawn_subagent` is
   * `mutating: false` by default, so several subagents in one assistant message
   * run in parallel and can each call `ask_questions` at the same time. Each
   * `ask` returns its own promise; the channel must not conflate them.
   *
   * Resolves with `status: "cancelled"` when `cancelPending()` is called while
   * this is awaiting, or when the underlying surface is closed.
   */
  ask(
    questions: Question[],
    scope: { depth: number },
  ): Promise<AskResult>;
  /**
   * Resolve **every** currently-pending `ask` with `status: "cancelled"`.
   * No-op when nothing is pending. Called by the surface on abort / disconnect.
   */
  cancelPending(): void;
}
```

**Presentation is one-at-a-time.** Although several batches may be *pending*
concurrently, a human can answer only one prompt/form at a time. Each surface
therefore presents pending batches **one at a time, in FIFO order**: it shows
the oldest pending batch, and when that one is answered (or cancelled) it shows
the next. The channel's job is to keep the pending set correct; the surface's
job is to serialize presentation.

`UserInputChannel` is a **type export** from the package root.

There are two implementations:

- **`ReplUserInputChannel`** (`src/cli/`) — prompts on the terminal's `readline`.
- **`ServerUserInputChannel`** (`src/server/`) — pushes an `askQuestions` event
  over the WebSocket and awaits the matching `answerQuestions` command.

### 2.2 Updated `AgentContext`

A new optional field is added to `AgentContext` (`src/agent/subagent.ts`):

| Field     | Type                 | Description                                                                 |
| --------- | -------------------- | --------------------------------------------------------------------------- |
| `channel` | `UserInputChannel`   | The user-input channel for this session tree. Omitted → no channel (headless). |

The channel is **shared across the whole session tree** (main agent and every
subagent), exactly like `render` and `client`. This is what makes subagent
`ask_questions` bubble to the top-level user for free: a subagent's tool calls
the same channel, tagged with the subagent's depth.

### 2.3 Updated `JsonSchema` (array support)

The existing `JsonSchema` / `JsonSchemaProperty` (`src/types.ts`) cannot express
an array, but `ask_questions` needs one (a list of question objects, each with an
`options` string array). Two additions:

`JsonSchemaProperty` gains:

| Field      | Type                 | Description                                                    |
| ---------- | -------------------- | -------------------------------------------------------------- |
| `type`     | … `\| "array"`       | `"array"` is added to the existing union.                      |
| `items`    | `JsonSchema`         | When `type` is `"array"`: the schema for each element.         |
| `maxItems` | `number`             | When `type` is `"array"`: maximum number of elements.          |

`validateArgs` (`src/tools/registry.ts`) gains array handling:

- If `prop.type === "array"` and the value is not an array → problem
  `"parameter \"<key>\" must be an array"`.
- If `prop.maxItems` is set and `value.length > prop.maxItems` → problem
  `"parameter \"<key>\" must have at most <maxItems> items"`.
- If `prop.items` is present and `prop.items.type === "object"`, each element is
  validated against `items` using the same required/property checks (one level
  of nesting is sufficient for this spec).

These additions are **additive**: existing schemas that use no arrays are
unaffected.

### 2.4 Updated Constants

- `BUILTIN_TOOL_NAMES` (`src/tools/names.ts`) gains `"ask_questions"`.
- `CORE_TOOL_NAMES` (`src/tools/metaTools.ts`) gains `"ask_questions"`, so in
  dynamic-tools mode it is always advertised (an interactive tool should not
  require a `search_tools` round-trip to discover).

### 2.5 State Transitions: A Turn With `ask_questions`

```
runTurn loop
  LLM emits an ask_questions tool call
    executeToolCalls → dispatch → ask_questions handler
      channel.ask(questions, { depth })        ← the turn BLOCKS here
        [REPL]  prompts the user, one question at a time
        [GUI]   pushes askQuestions event; awaits answerQuestions command
      ← resolves with AskResult
    handler returns the AskResult as a tool-result string
  LLM receives the answers and continues the turn
```

The turn is blocked for as long as the user takes. There is no timeout (§1.3).

---

## 3. Functional Requirements

### 3.1 The `ask_questions` Tool

**Name:** `ask_questions`
**Mutating:** `false` (it changes no workspace/session state; it only reads from
the user). It therefore runs in the read-only (concurrent) partition of
`executeToolCalls`. In practice only one is ever pending at a time (§8).

**Parameters (JSON schema):**

```jsonc
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "maxItems": 3,
      "description": "The questions to ask (1–3).",
      "items": {
        "type": "object",
        "properties": {
          "id":      { "type": "string", "description": "Stable key for this question's answer. Unique within the batch." },
          "text":    { "type": "string", "description": "The question prompt." },
          "options": { "type": "array", "items": { "type": "string" }, "description": "The choices. Omit for a free-text question." },
          "select":  { "type": "string", "enum": ["single", "multiple"], "description": "How many options may be chosen. Default \"single\". Only with options." }
        },
        "required": ["id", "text"]
      }
    }
  },
  "required": ["questions"]
}
```

**Description (shown to the model):**

> Ask the user a small batch of structured questions (1–3) and wait for their
> answers before continuing. Each question is either a choice (provide `options`;
> `select` is `"single"` for exactly one or `"multiple"` for one or more) or a
> free-text question (omit `options`). The user may always add free text in
> addition to choosing options. Use this when a decision has several reasonable
> alternatives and you want the user's input rather than guessing.

**Handler behavior:**

1. Read `args.questions`. It is validated by `validateArgs` before the handler
   runs (an array of 1–3 objects, each with `id` and `text`).
2. If the session has **no channel** (headless), return the unavailable result
   string (§3.5) and stop.
3. Otherwise call `channel.ask(questions, { depth })`, where `depth` is the
   depth of the agent calling the tool (captured at construction time).
4. Serialize the resolved `AskResult` to a tool-result string (§3.4) and return
   it.

The tool is constructed by `makeAskQuestionsTool(channel, depth)` and registered
in `buildToolRegistry` (which receives the channel from `materializeProfile`,
which reads it from `AgentContext`).

### 3.2 Channel Threading

The channel flows through the existing session machinery, mirroring how `render`
and `client` are threaded:

1. The surface (REPL entry or agent-server) creates its `UserInputChannel` and
   passes it to `createSession` via a new `SessionOptions.channel` field.
2. `createSession` stores it in the shared `AgentContext` (`ctx.channel`).
3. `materializeProfile` passes `ctx.channel` to `buildToolRegistry`.
4. `buildToolRegistry` registers `makeAskQuestionsTool(ctx.channel, depth)`.

Because the channel lives in the shared `AgentContext`, **every agent in the
tree** (main + all subagents, at every depth) gets an `ask_questions` tool bound
to the **same** channel, tagged with its own depth. No per-subagent wiring is
needed.

A session created **without** a channel (e.g. a unit test, a headless run) has
`ctx.channel === undefined`; its `ask_questions` tool is still registered but
returns the unavailable string (§3.5).

### 3.3 REPL Channel (`ReplUserInputChannel`)

Lives in `src/cli/`. Wraps the REPL's `readline` interface.

The channel keeps a FIFO queue of pending batches. `ask` enqueues a batch and
returns a promise; a single presenter loop pulls batches off the front one at a
time and prompts for them. (In practice the queue holds at most a handful of
batches — one per concurrently-asking subagent — but the design does not depend
on that bound.)

**`ask(questions, { depth })`:**

- Enqueue `{ questions, depth, resolve }` and return the promise.
- The presenter loop, when the queue is non-empty and no batch is currently on
  screen, takes the front batch and prompts for its questions **in order**:
  - **Choice question:** render the options numbered (`1. …`, `2. …`, …) plus a
    free-text line. Accept either:
    - a number (single) → that option is selected;
    - comma-separated numbers (multiple) → those options are selected;
    - free text → recorded as `text` (and, for a single-choice question, if the
      text matches an option exactly, it is also recorded as `selected`).
  - **Free question:** read a line of text → recorded as `text`.
- Indent the prompt by the batch's `depth` (matching the subagent indentation
  used elsewhere in the REPL), so a subagent's questions are visually nested.
- A **required** question (all questions are required in this version) re-prompts
  on an empty answer; an empty answer is never accepted.
- When the batch's questions are all answered, resolve its promise with
  `AskResult { status: "answered", answers }` and present the next queued batch
  (if any).

**`cancelPending()`:**

- Resolves **every** queued/in-flight batch with `{ status: "cancelled", answers: {} }`,
  clears the queue, and clears the pending readline prompt. Called by the REPL's
  SIGINT handler (E15 path) so an aborted turn does not leave a dangling prompt.

### 3.4 Result Serialization

The `AskResult` is returned to the model as a JSON string:

```jsonc
// answered
{
  "status": "answered",
  "answers": {
    "approach": { "selected": ["refactor"], "text": "" },
    "files":    { "selected": [], "text": "src/agent/loop.ts and src/cli/repl.ts" }
  }
}

// cancelled
{ "status": "cancelled", "answers": {} }
```

Rules:

- The string is the **exact** `JSON.stringify(askResult)` — no truncation. The
  result is small (≤ 3 questions) and is the payload, so it is exempt from
  `maxToolOutputChars` (the tool sets `noTruncate: true`, like `read_skill`).
- `selected` lists the chosen options **in the order they were presented**.
- `text` is the free text, trimmed. Empty string when none.

### 3.5 No Channel (Headless)

When the session has no channel, the handler returns this exact string (no
`channel.ask` is called):

```
The user is not available to answer questions right now. Make your best decision and proceed without asking.
```

This is a **result string**, not a thrown error — consistent with the
"tool errors are data, not control" invariant. The model reads it and continues
on its own judgment.

### 3.6 GUI Channel (`ServerUserInputChannel`) + Protocol

Lives in `src/server/`. The agent-server "never touches stdin," so the channel
round-trips over the WebSocket.

**Server side:**

- Holds a `Map<requestId, (result: AskResult) => void>` of pending asks. The map
  naturally supports **several concurrent pending batches** (one per
  concurrently-asking subagent); each `ask` mints its own `requestId`.
- **`ask(questions, { depth })`:** mints a `requestId` (`newId()`), stores the
  resolver, pushes an `askQuestions` event, and awaits the resolver.
- **`cancelPending()`:** resolves **every** pending ask with
  `{ status: "cancelled", answers: {} }` and clears the map. Called by
  `doAbort` and by the WebSocket `close` handler.

**Protocol additions** (additive; the client must tolerate unknown types, GUI
spec §4.11). Mirrored by hand in `gui/src/types.ts`.

Server → client event:

```jsonc
{
  "type": "askQuestions",
  "id": string,                 // the requestId; echoed back in the answer
  "scope": Scope,               // { kind: "main" } or { kind: "subagent", id, depth }
  "questions": [                // 1–3 Question objects (§2.1)
    { "id": string, "text": string, "options"?: string[], "select"?: "single"|"multiple" }
  ]
}
```

Client → server command:

```jsonc
{
  "type": "answerQuestions",
  "id": string,                 // the requestId from the askQuestions event
  "answers": {                  // keyed by question id
    "<questionId>": { "selected": string[], "text": string }
  }
}
```

**Server handling of `answerQuestions`:**

- Look up the resolver by `id`. If found, resolve it with
  `{ status: "answered", answers }` and delete the entry.
- If not found (stale/duplicate), send a `commandResult` with
  `ok: false, error: "No pending question batch with id <id>."`.

**Scope correlation:** the server builds the `Scope` for the event the same way
it does for other subagent events — by the asking agent's depth (a new
`subagentIds`-style correlation is not needed because the channel is called from
within the agent's own tool execution, which already knows its depth; the server
maps depth → active subagent id using the existing `subagentIds` map, falling
back to `{ kind: "main" }` at depth 0).

### 3.7 GUI Client (Form)

The GUI client (`gui/src/`) renders an `askQuestions` event as a **form** and
sends one `answerQuestions` command on submit.

- **Store** (`gui/src/store.ts`): a new signal holds a **FIFO queue** of pending
  batches (`{ id, scope, questions }[]`). `applyEvent` appends on `askQuestions`
  and shifts on `answerQuestions` (sent) or on `turnEnd`/`cleared`/`snapshot`
  (defensive reset — clears the whole queue). Only the **front** of the queue is
  rendered at a time; the rest wait. The batch is **not** a conversation row —
  it is a modal overlay, so it does not enter `rows`/`blocks`.
- **Rendering** (`gui/src/App.tsx`): when the queue is non-empty, render a form
  overlay (above the conversation) for the **front** batch, with, per question:
  - the question `text`;
  - for a choice question: the options as radio buttons (`single`) or checkboxes
    (`multiple`), **plus** a free-text input (the "free answer where anything
    goes");
  - for a free question: a text input;
  - a single **Submit** button.
- **Submit:** build the `answers` object (selected options in presented order +
  trimmed free text per question) and `client.send({ type: "answerQuestions", id, answers })`,
  then shift the queue so the next batch (if any) renders; when the queue is
  empty the composer is restored.
- **Validation:** a question with no selection **and** no free text blocks
  submit (the user must provide something for each question). This mirrors the
  REPL's "re-prompt on empty" rule.
- **Subagent scope:** when `scope.kind === "subagent"`, the form is labelled with
  the subagent (e.g. a "subagent is asking…" header) so the user knows the
  request came from a nested agent.

---

## 4. Edge Cases and Error Handling

| #   | Scenario                                                                                  | Behavior                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `ask_questions` called with no channel (headless/test)                                    | Returns the §3.5 "user unavailable" string. No `channel.ask` is called.                                                                              |
| E2  | `questions` is empty (`[]`)                                                                | `validateArgs` rejects it (the schema requires the array; an empty array fails the "1–3" intent). The model gets an `Invalid arguments` result and can retry. |
| E3  | More than 3 questions                                                                       | `validateArgs` rejects via `maxItems: 3`. The model gets an `Invalid arguments` result.                                                              |
| E4  | Two questions share the same `id`                                                          | The later one overwrites the earlier in the `answers` map. (The model is instructed to use unique ids; this is a model error, not a crash.)            |
| E5  | A choice question with `select: "multiple"` but the user picks one option                  | Valid. `selected` has one entry.                                                                                                                     |
| E6  | A choice question with `select: "single"` but the user picks two (GUI)                     | The GUI enforces single-select (radio buttons), so this cannot happen in the GUI. In the REPL, comma-separated numbers on a single question select only the last. |
| E7  | The user provides only free text on a choice question (no options selected)               | Valid. `selected` is empty, `text` is set.                                                                                                           |
| E8  | The user provides only an option (no free text)                                            | Valid. `selected` is set, `text` is `""`.                                                                                                            |
| E9  | The turn is aborted (REPL Ctrl-C / GUI `abort`) while a batch is pending                   | `cancelPending()` resolves the batch with `status: "cancelled"`. The tool returns the cancelled JSON. The turn is also aborted as it is today.        |
| E10 | The GUI client disconnects while a batch is pending                                        | The WebSocket `close` handler calls `cancelPending()`. The batch resolves `cancelled`; the turn continues (or is aborted by the surface).             |
| E11 | A stale/duplicate `answerQuestions` command (unknown `id`)                                 | The server sends `commandResult { ok: false, error: "No pending question batch with id <id>." }`. No crash.                                           |
| E12 | A subagent calls `ask_questions`                                                           | The request is presented to the top-level user, scoped/indented to the subagent. The answer returns to the subagent's tool call.                      |
| E13 | A subagent's `ask_questions` is pending and the subagent is aborted                        | `cancelPending()` resolves it `cancelled`; the subagent's turn ends as it would on any abort.                                                        |
| E14 | `ask_questions` is called concurrently with another tool in the same batch                 | It runs in the read-only (concurrent) partition. The other tools run in parallel; `ask_questions` blocks on the channel. Results are returned in original call order. |
| E15 | The user answers a free question with whitespace only                                     | Treated as empty → re-prompted (REPL) / submit blocked (GUI). Whitespace-only is never accepted as an answer.                                         |
| E16 | A question's `options` is an empty array `[]`                                              | Treated as a free question (no choices to show). The user types free text.                                                                            |
| E17 | The model calls `ask_questions` after already calling `finish` in the same batch           | `finish` is terminal and handled before the other calls execute (existing loop behavior), so `ask_questions` in the same batch does not run.          |
| E18 | Two subagents (same depth, `mutating: false`) call `ask_questions` concurrently            | Both batches are pending at once. Each surface presents them **one at a time, FIFO**: the user answers the first, then the second. Each `ask` resolves independently with its own answers. `cancelPending()` cancels both. |

---

## 5. Non-Functional Requirements

- **Performance:** `ask_questions` adds no overhead to the hot path. It blocks
  only while the user is answering. The channel is a no-op (returns the
  unavailable string) when absent, so headless sessions pay nothing.
- **Memory:** Each pending batch holds at most 3 questions and one resolver.
  Several batches can be pending concurrently (one per concurrently-asking
  subagent), but the count is bounded by the number of live subagents.
  Negligible.
- **Security:** The channel is local (REPL stdin / localhost WebSocket). No new
  attack surface beyond the existing GUI protocol. The `answerQuestions` command
  is validated by `id` lookup; a wrong `id` is rejected, not injected.
- **Compatibility:** All changes are additive. The protocol additions
  (`askQuestions` event, `answerQuestions` command) are new `type` values; an
  older client ignores the event (GUI spec §4.11) and simply never answers, so
  the batch stays pending until abort/disconnect. Existing schemas that use no
  arrays are unaffected by the `JsonSchema` additions.
- **Backward compatibility of the tool surface:** `ask_questions` is a new
  built-in. Profiles that explicitly enumerate their tools (Profile→Tool edges)
  and do **not** include `ask_questions` will not get it — consistent with how
  every other built-in is gated by the edge rule.

---

## 6. Data Requirements

- **Input:** `ask_questions` takes `{ questions: Question[] }` (1–3).
- **Output:** a JSON string of `AskResult` (§3.4), returned as the tool result.
- **Storage:** No persistent storage. A pending batch is ephemeral — it exists
  only for the duration of the `channel.ask` call. The answers live only in the
  conversation (as a tool-result message), subject to compaction.
- **Protocol:** two new message types (§3.6), additive, mirrored in
  `gui/src/types.ts`.

---

## 7. External Dependencies

- **`node:readline`** — already used by the REPL; the REPL channel reuses the
  existing interface.
- **`newId`** from `src/utils.ts` — for the GUI channel's request ids. Already
  exists.
- No new runtime dependencies.

---

## 8. Constraints and Assumptions

- **Several batches may be pending concurrently.** `spawn_subagent` is
  `mutating: false` by default, so several subagents in one assistant message run
  in parallel (only serialized when the provider sets `serializeSubagents`).
  Two same-depth subagents can therefore both call `ask_questions` at once, and
  each `ask` must resolve independently. The channel keeps a set of pending
  batches (the GUI's `Map<requestId, resolver>` does this naturally); each
  surface **presents them one at a time, FIFO** (§3.3, §3.7), because a human
  can answer only one prompt at a time. `cancelPending()` cancels all of them.
- **The channel is shared across the session tree.** This is what makes
  subagent `ask_questions` bubble to the top-level user. It also means the user
  always answers at the top level, never "inside" a subagent.
- **All questions are required.** There is no optional-question mode in this
  version; an empty answer is always re-prompted / blocks submit. (The `Question`
  shape leaves room for a future `required` flag.)
- **The result is not truncated.** `ask_questions` sets `noTruncate: true`
  because its result is the payload (≤ 3 answers) and truncating it would defeat
  the purpose — same rationale as `read_skill`.
- **`ask_questions` is read-only (`mutating: false`).** It changes no
  workspace/session state. It runs in the concurrent partition, so several
  `ask_questions` calls (from concurrent subagents) may be pending at once; the
  channel handles that (§8, first bullet).
- **The REPL reuses its existing `readline` interface.** The channel does not
  create a second interface; it issues `rl.question` on the one the REPL already
  owns, so history/echo behavior is unchanged.
- **The GUI form is a modal overlay, not a conversation row.** It does not enter
  `rows`/`blocks`, so it does not disturb the subagent-block grouping or the
  snapshot/inflight reconstruction.

---

## 9. Acceptance Criteria

| #   | Criterion                                                                                                                                                                                                 | Verification                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A1  | `ask_questions` is in `BUILTIN_TOOL_NAMES` and `CORE_TOOL_NAMES`.                                                                                                                                       | Unit test (constant membership).       |
| A2  | A session with a channel: calling `ask_questions` with one free question returns the user's text as `{ status: "answered", answers: { <id>: { selected: [], text } } }`.                                | Unit test (mock channel).              |
| A3  | A session with a channel: a single-choice question returns the chosen option in `selected`.                                                                                                             | Unit test (mock channel).              |
| A4  | A session with a channel: a multiple-choice question returns all chosen options in `selected`, in presented order.                                                                                     | Unit test (mock channel).              |
| A5  | A session with **no** channel: `ask_questions` returns the exact §3.5 "user unavailable" string and does not call the channel.                                                                        | Unit test.                            |
| A6  | `validateArgs` rejects `questions` with more than 3 items (`maxItems`).                                                                                                                                  | Unit test (schema validation).         |
| A7  | `validateArgs` rejects a non-array `questions`.                                                                                                                                                           | Unit test (schema validation).         |
| A8  | `validateArgs` accepts a valid batch and validates each question object's `id`/`text` (required) and `options` (array of strings).                                                                    | Unit test (schema validation).         |
| A9  | The result string is `JSON.stringify(AskResult)` and is **not** truncated (the tool sets `noTruncate: true`).                                                                                          | Unit test.                            |
| A10 | `cancelPending()` resolves a pending `ask` with `{ status: "cancelled", answers: {} }`.                                                                                                                  | Unit test (mock channel).              |
| A11 | A subagent's `ask_questions` calls the **same** channel as the main agent, tagged with the subagent's depth.                                                                                             | Integration test (mock channel + mock SSE server). |
| A12 | The REPL channel prompts one question at a time, accepts a number / comma-separated numbers / free text, and re-prompts on empty.                                                                      | Manual / integration (REPL).           |
| A13 | The GUI `askQuestions` event renders a form; submitting sends one `answerQuestions` command with the correct `answers`; the pending batch clears.                                                     | GUI store unit test + manual.          |
| A14 | The GUI rejects submit when any question has no selection and no free text.                                                                                                                               | GUI store / component test.            |
| A15 | A stale `answerQuestions` (unknown `id`) yields `commandResult { ok: false }` and does not crash.                                                                                                        | Server unit test.                      |
| A16 | Aborting the turn (REPL SIGINT / GUI `abort`) while a batch is pending resolves it `cancelled` and does not leave a dangling prompt/resolver.                                                          | Integration test.                      |
| A17 | The protocol additions are additive: an older client that ignores `askQuestions` does not crash the server; the batch stays pending until abort/disconnect.                                            | Server unit test.                      |
| A18 | `src/index.ts` exports `Question`, `QuestionAnswer`, `AskResult`, and `UserInputChannel` as types, and remains side-effect-free.                                                                      | Type-check + import test.              |
| A19 | A profile that enumerates tools without `ask_questions` does not get the tool; the default profile (no edges) does.                                                                                     | Unit test (registry selection).        |

---

## 10. Open Questions

_(None — all design decisions were confirmed with the user.)_
