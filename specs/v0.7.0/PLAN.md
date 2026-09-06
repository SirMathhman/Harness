# Plan: Implement `ask_questions` Tool (v0.7.0)

Implements `specs/v0.7.0/SPECIFICATION-v0.7.0.md`. Adds a built-in `ask_questions`
tool that pauses the turn and asks the human a small batch of structured questions
(1–3), then continues with the answers. A new **user-input channel** is threaded
through the session tree so the tool reaches the human on whichever surface is
active (REPL readline or GUI WebSocket). Several batches may be pending
concurrently (concurrent subagents); each surface presents them one at a time, FIFO.

**Approach:** follow the existing `render`/`client` threading pattern exactly —
add an optional `channel` field to `AgentContext`, thread it through
`SessionOptions` → `createSession` → `ctx`, and register the tool in
`buildToolRegistry` (which `materializeProfile` feeds with `ctx.channel` + `depth`).
Because `AgentContext` is shared by reference across the whole tree, every agent
(main + all subagents, every depth) gets the tool bound to the same channel,
tagged with its own depth — no per-subagent wiring.

---

## Phase 0 — Prerequisites (schema + constants)

These are independent of each other → **run in parallel**.

1. **Extend `JsonSchemaProperty`** — `src/types.ts:82`. Add `"array"` to the
   `type` union; add optional `items?: JsonSchema` and `maxItems?: number`.
   (Spec §2.3. Additive — existing schemas unaffected.)
2. **Extend `validateArgs`** — `src/tools/registry.ts:57`. Add array handling per
   spec §2.3: non-array value → `"parameter \"<key>\" must be an array"`;
   `maxItems` exceeded → `"…must have at most <maxItems> items"`; when
   `items.type === "object"`, validate each element against `items` (one level of
   nesting).
3. **Add the tool name** — `src/tools/names.ts:8` (`BUILTIN_TOOL_NAMES`) and
   `src/tools/metaTools.ts:11` (`CORE_TOOL_NAMES`) both gain `"ask_questions"`
   (spec §2.4).

## Phase 1 — Core types + channel threading

*Depends on Phase 0.* Steps 4–7 are sequential (each builds on the prior).

4. **Define the domain types** — new file `src/agent/userInput.ts` (or add to
   `src/types.ts`): `Question`, `QuestionAnswer`, `AskResult`, and the
   `UserInputChannel` interface (`ask(questions, { depth }): Promise<AskResult>`;
   `cancelPending(): void`) — verbatim per spec §2.1. Export all four as **types**
   from `src/index.ts` (keep it side-effect-free; add to the type-export block).
5. **Add `channel` to `AgentContext`** — `src/agent/subagent.ts:58`:
   `channel?: UserInputChannel`.
6. **Thread through session creation** — `src/agent/session.ts`: add
   `channel?: UserInputChannel` to `SessionOptions` (line 31); in `createSession`
   (line 155) fold it into `ctx` exactly like `render`/`client`
   (`...(options.channel !== undefined ? { channel: options.channel } : {})`).
7. **Register the tool in the registry** — `src/tools/index.ts:54`: extend
   `buildToolRegistry(config, selection, opts?)` with `opts?: { channel?:
   UserInputChannel; depth: number }`; when present, register
   `makeAskQuestionsTool(opts.channel, opts.depth)`. In `materializeProfile`
   (`src/agent/subagent.ts:162`, the `buildToolRegistry` call at ~line 175) pass
   `{ channel: ctx.channel, depth }` — `depth` is already a parameter of
   `materializeProfile`. (Mirrors how `spawn_subagent` is registered separately in
   `materializeProfile` because it needs ctx-derived deps.)

## Phase 2 — The tool

*Depends on Phase 1.*

8. **`makeAskQuestionsTool(channel, depth)`** — new file `src/tools/askQuestions.ts`.
   Factory returns a `Tool` (shape per `src/types.ts:38`):
   - `name: "ask_questions"`, `mutating: false`, `noTruncate: true`.
   - `parameters`: the JSON schema from spec §3.1 (`questions` array, `maxItems: 3`,
     `items` object with `id`/`text` required, `options` string array, `select`
     enum).
   - `description`: the model-facing text from spec §3.1.
   - `handler`: if `channel === undefined` → return the exact §3.5 "user
     unavailable" string (no `channel.ask` call). Else `await
     channel.ask(questions, { depth })` and return `JSON.stringify(result)`
     (spec §3.4 — exact stringify, no truncation).

## Phase 3 — REPL channel

*Depends on Phase 1. Parallel with Phases 4 and 5.*

9. **`ReplUserInputChannel`** — new file `src/cli/userInput.ts`. Wraps the REPL's
   `readline` `Interface`. Keeps a FIFO queue of pending batches; a single
   presenter loop pulls the front batch and prompts its questions in order
   (choice → numbered options + free text; free → text line), indenting by
   `"  ".repeat(depth) + "  "` (matching `makeSubagentRender`, `src/cli/repl.ts:246`),
   re-prompting on empty (all questions required). `cancelPending()` resolves
   **every** queued batch `cancelled` and clears the pending prompt.
10. **Wire into the REPL** — `src/cli/repl.ts`: construct the channel in
    `startRepl` (needs the `rl` from lines 86–89) and pass it to `createSession`
    (line 79) as `channel`. In the per-turn `onSigint` handler (lines 177–181)
    call `channel.cancelPending()` so an aborted turn doesn't leave a dangling
    prompt. (The main loop is blocked inside `executeTurn` for the whole turn, so
    the channel's `rl.question` never races the loop's `prompt`.)

## Phase 4 — Server channel + protocol

*Depends on Phase 1. Parallel with Phases 3 and 5.*

11. **Protocol types** — `src/server/protocol.ts`: add the `askQuestions`
    server→client event (`{ id, scope, questions }`) and the `answerQuestions`
    client→server command (`{ id, answers }`) per spec §3.6.
12. **`ServerUserInputChannel`** — on `AgentServer` (`src/server/server.ts`).
    Holds `pendingAsks = new Map<requestId, (r: AskResult) => void>()`.
    - `ask(questions, { depth })`: mint `requestId` via `newId()` (imported at
      server.ts:27), store the resolver, `emit` an `askQuestions` event (scope from
      `subagentIds` depth→id, `{ kind: "main" }` at depth 0), await the resolver.
    - `cancelPending()`: resolve **every** pending ask `cancelled`, clear the map.
    - Wire `channel` into `createSession` (server.ts:87).
    - Add `case "answerQuestions"` to `handleCommand` (server.ts:286, before
      `default:` at 309): look up resolver by `id`; if found resolve `answered` +
      delete; else send `commandResult { ok: false, error: "No pending question
      batch with id <id>." }`.
    - Call `cancelPending()` in `doAbort` (server.ts:389) and `onWsClose`
      (server.ts:280).

## Phase 5 — GUI client

*Depends on Phase 1 (types). Parallel with Phases 3 and 4.*

13. **Mirror protocol types** — `gui/src/types.ts`: add `askQuestions` to
    `ServerEvent` (line 7) and `answerQuestions` to `ClientCommand` (line 55).
    (Unknown-type tolerance already holds — `applyEvent` has no `default` case.)
14. **Store FIFO queue** — `gui/src/store.ts`: add a `pendingQuestions` signal
    (`{ id, scope, questions }[]`) near the other signals (lines 28–46). In
    `applyEvent` (line 166): append on `askQuestions`; the three reset cases
    (`snapshot` 168, `turnEnd` 261, `cleared` 278) clear the whole queue. Expose
    `pendingQuestions` (and a `submitAnswers(id, answers)` helper that shifts the
    queue) in the returned object (line 339). The batch is **not** a row — it never
    enters `rows`/`blocks`.
15. **Form overlay** — new `QuestionForm` component in `gui/src/Markdown.tsx`
    (pattern: `SubagentBlock` at line 100) + render in `gui/src/App.tsx` as a
    `<Show when={store.pendingQuestions().length > 0}>` overlay above the
    conversation (near the `<main class="layout">` at line 219 / `<footer
    class="inputbar">` at 282). Renders only the **front** batch: per question,
    radio (`single`) / checkboxes (`multiple`) + a free-text input, or a text
    input for free questions; a single Submit. Submit builds `answers` (selected in
    presented order + trimmed text), `client.send({ type: "answerQuestions", id,
    answers })`, then shifts the queue. Validation: block submit if any question
    has no selection and no free text. Label the form when `scope.kind ===
    "subagent"`.
16. **CSS** — `gui/src/styles.css`: add `.question-overlay` (fixed, centered card)
    and `.question-form`, reusing `.control` (line 71) for inputs and `.send`
    (line 290) for submit; match the `.subagent` card style (line 222).

## Phase 6 — Tests + verification

*Depends on Phases 2–5.*

17. **Tool unit tests** — `test/askQuestions.test.ts` (new): mock channel injected
    via `makeAskQuestionsTool` / `createSession({ channel })`. Cover: free
    question returns text (A2); single-choice returns `selected` (A3);
    multiple-choice returns all in order (A4); no channel → exact §3.5 string, no
    `channel.ask` (A5); result is `JSON.stringify` and not truncated (A9);
    `cancelPending()` resolves `cancelled` (A10).
18. **Schema validation tests** — extend `test/tools.test.ts`: `validateArgs`
    rejects >3 items (A6), rejects non-array (A7), accepts a valid batch and
    validates each question's `id`/`text`/`options` (A8).
19. **GUI store tests** — extend `test/guiStore.test.ts`: `askQuestions` appends to
    the queue; FIFO order across two batches; submit shifts; `turnEnd`/`cleared`/
    `snapshot` clear the queue (A13, A14).
20. **Server tests** — extend `test/server.test.ts`: `answerQuestions` resolves the
    matching ask; stale/unknown `id` → `commandResult { ok: false }` (A15); abort
    and WS close cancel pending asks (A16); older client ignoring `askQuestions`
    doesn't crash the server (A17).
21. **Integration** — extend `test/subagent.test.ts` or `test/integration.test.ts`:
    a subagent's `ask_questions` calls the **same** channel as the main agent,
    tagged with the subagent's depth (A11).
22. **Manual** — REPL: run a task that triggers `ask_questions`, answer a
    single/multiple/free question, confirm indentation + re-prompt-on-empty; Ctrl-C
    mid-ask cancels cleanly. GUI: same, confirm the form renders, submit returns
    answers, and a subagent's ask is labelled.

---

## Relevant files

- `src/types.ts:82` — `JsonSchemaProperty` (add `"array"`, `items`, `maxItems`).
- `src/tools/registry.ts:57` — `validateArgs` (array handling).
- `src/tools/names.ts:8`, `src/tools/metaTools.ts:11` — name lists.
- `src/agent/userInput.ts` — **new**: `Question`, `QuestionAnswer`, `AskResult`,
  `UserInputChannel`.
- `src/index.ts` — type exports.
- `src/agent/subagent.ts:58` — `AgentContext.channel`; `:162` `materializeProfile`
  passes channel+depth to the registry.
- `src/agent/session.ts:31,155` — `SessionOptions.channel` → `ctx`.
- `src/tools/index.ts:54` — `buildToolRegistry` registers the tool.
- `src/tools/askQuestions.ts` — **new**: `makeAskQuestionsTool`.
- `src/cli/userInput.ts` — **new**: `ReplUserInputChannel`.
- `src/cli/repl.ts:79,177` — wire channel + `cancelPending` on SIGINT.
- `src/server/protocol.ts` — `askQuestions` / `answerQuestions` types.
- `src/server/server.ts:87,286,389,280` — channel, dispatch, abort/close cancel.
- `gui/src/types.ts:7,55` — mirrored protocol types.
- `gui/src/store.ts:28-46,166,339` — FIFO queue signal + `applyEvent` + resets.
- `gui/src/Markdown.tsx:100`, `gui/src/App.tsx:219,282` — `QuestionForm` + overlay.
- `gui/src/styles.css:71,222,290` — form/overlay styles.
- `test/askQuestions.test.ts` (new), `test/tools.test.ts`, `test/guiStore.test.ts`,
  `test/server.test.ts`, `test/subagent.test.ts` — tests.

## Verification

1. `bun run typecheck` — clean (new types, schema additions, threading).
2. `bun run lint` — clean.
3. `bun test` — all suites pass, including the new `test/askQuestions.test.ts` and
   the extended schema/store/server/subagent tests (acceptance A1–A19).
4. Manual REPL: trigger `ask_questions` (single/multiple/free), confirm answers
   return to the model, indentation, re-prompt-on-empty, and Ctrl-C cancels cleanly.
5. Manual GUI (`bun run gui`): confirm the form renders above the conversation,
   submit returns answers, a subagent's ask is labelled, and abort/disconnect
   cancels pending batches.

## Decisions

- **Registration site:** `buildToolRegistry` (per spec §3.2), fed by
  `materializeProfile` with `ctx.channel` + `depth` — not a separate
  `materializeProfile`-only registration like `spawn_subagent`, because the
  channel is already on the shared `ctx`.
- **Concurrency model:** the channel holds a *set* of pending batches (GUI
  `Map<requestId, resolver>`; REPL FIFO queue); each surface *presents* them one at
  a time, FIFO. This is robust to any number of concurrently-asking subagents
  (spec §8, E18).
- **`mutating: false` + `noTruncate: true`** — runs in the concurrent partition;
  result is the payload so it is never truncated (spec §3.1, §3.4).
- **Headless:** no channel → exact §3.5 string, a result (not a throw).
- **Scope:** in scope — REPL + GUI surfaces, subagent bubbling, headless fallback,
  abort/disconnect cancellation. Out of scope (spec §1.3): timeouts,
  editing/re-asking, rich option metadata.
