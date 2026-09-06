# Plan: Bounded GUI Conversation Rendering

## Goal and decisions

One cohesive improvement: bound conversation rendering work to the viewport and changed rows (priority 9/10). Preserve the complete client-received history in memory; eliminate historical DOM remounts on streaming updates. User selected seamless scrolling rather than paging and permits GUI-only runtime dependencies plus browser-test development dependencies. Use @tanstack/solid-virtual with a version verified against Solid 1.9; add Playwright browser coverage. No implementation performed; tools for execution/browser profiling were unavailable.

## Verified findings

- c:\Projects\Harness\gui\src\App.tsx renders every result of store.blocks() in a Solid For. No windowing exists.
- c:\Projects\Harness\gui\src\store.ts appendText copies the full rows array and replaces one row on every delta. blocks() scans all rows and creates new wrapper objects for every main row and every adjacent same-scope run. Solid For keys by item identity, so these fresh wrappers cause historical subtree remounts. A createMemo alone or a fictional For `by` property does not fix this.
- c:\Projects\Harness\gui\src\Markdown.tsx ReasoningBlock and SubagentBlock mount their children even while details is closed. Markdown already memoizes marked.parse per component, but wrapper remounts destroy those memos. ItemContent captures props.item in a local const and uses a one-time switch; this needs reactive access when remounting is removed.
- App's requestAnimationFrame only coalesces scroll writes, not event application/Markdown parsing.
- Subagent grouping is adjacent same-scope runs, not one global group per scope. A scope may appear in several runs and cannot alone identify a group.
- Existing test/guiStore.test.ts covers snapshot/state/per-scope reasoning/stream continuation/grouping, but no browser mount counts, scrolling or timing. gui/package.json has no browser runner. Root typecheck does not replace separate GUI checking.
- Server owns protocol and snapshots; snapshot is authoritative, history lacks persistent UI row IDs and live nesting metadata. Do not invent cross-snapshot identity matching from text or change the protocol in this fix.

## Phase 1 — Baseline and reactive foundation

1. Build deterministic browser fixtures and capture baseline (first; test setup can run in parallel with step 2 once fixture event format is agreed).
   - Add gui/e2e/conversation.perf.spec.ts and gui/playwright.config.ts, plus browser-test script in gui/package.json. Use _.spec.ts outside Bun's _.test.ts convention; explicitly verify root bun test does not collect Playwright tests, configuring ignore if needed.
   - Drive the actual Vite GUI through a test-only/mock WebSocket fixture, without a provider or local user config. No production debug endpoint. Reuse protocol shapes and basicState/snapshot conventions from test/guiStore.test.ts. Fixture helper lives under gui/e2e/.
   - Compare 100, 1,000 and 10,000 logical rows: mixed Markdown, reasoning, tool calls/results, interleaved scopes, a single expanded subagent with thousands of children, snapshot + inflight replay, and sustained deltas to a live row.
   - Record DOM counts, historical node identity/mutations, mounted render items, long tasks, frame times, update latency, and heap after repeat scrolling/clear. Separate full-snapshot O(history) ingestion from steady-state streaming. Timing thresholds are provisional until recorded on a named browser/machine.
2. Make row updates stable and granular (foundation for all rendering changes).
   - Refactor createStore in gui/src/store.ts to use solid-js/store path updates (alias that import) or equivalent stable per-row reactive records. Choose stable reactive records with path updates; avoid full rows-array copies for appendText. Preserve externally callable rows() semantics for existing consumers/tests as practical.
   - Mint local row IDs within an authoritative snapshot generation. Give adjacent-run groups IDs derived from generation plus first row ID, not scope alone. Keep per-scope streamingTarget continuation.
   - Maintain stable structural block records incrementally when rows are appended; text changes must not rebuild blocks or invalidate the sequence. A snapshot may rebuild once in a batch. Keep active/done facts reactive independently of structural lists; avoid allocating a new active Set for an already-active row and use targeted subscriptions/selectors.
   - Rewrite ItemContent to use reactive discriminant/content access so replacing a nested item still updates a mounted component. Keep Row/Markdown mounted when only text changes; do not fake keying with unsupported For props.
   - Add deterministic tests: inactive row/group identity stable over 1,000 deltas; block structure computations not triggered by text-only changes; exact interleaved text/order and no stale content.

## Phase 2 — Virtual viewport and interaction state

3. Introduce a windowed conversation view (depends on step 2).
   - Add gui/src/conversation/ConversationViewport.tsx and gui/src/conversation/viewModel.ts. App delegates its conversation body and scroll handling to this component; preserve toolbar/input behavior.
   - View model flattens current display structure into stable render-item IDs: main rows, subagent headers, and child rows only for expanded runs. Do not virtualize an entire large expanded SubagentBlock as one item or use nested unbounded For loops. Keep current event order, indentation and adjacent-run grouping.
   - Keep disclosure state in the view-model layer, outside disposable row components, keyed by row/run ID. Domain active/done facts determine initial state and genuine lifecycle transitions; manual user choices persist across text updates and offscreen unmount/remount. Completion collapses the relevant groups; finishing the main turn must not reopen completed groups. Reset view state on clear/new authoritative snapshot; no permanent localStorage expansion history.
   - Use createVirtualizer, getItemKey, getVirtualItems, measureElement and ResizeObserver for variable heights. Feed stable render IDs to Solid For (do not key by newly allocated virtual-item objects). Start with overscan 8 each side; tune with recorded traces.
   - Use a total-height spacer and measured positioned items. Integrate gap/padding into measurements; remove conflicting flex-child shrinking/margins. Invalidate/re-measure appropriately on viewport width changes, wrapping, expansion, images and font/layout changes. Measurement updates must not create resize loops. Clean up observers and references.
   - Flattened groups need accessible disclosure buttons (native keyboard support, aria-expanded and meaningful labels) rather than invalid details children scattered across virtual rows. Preserve readable group association/indentation without creating controls targeting nonexistent offscreen elements.
4. Preserve navigation and lazy rendering (depends on step 3; tests can be authored in parallel).
   - Centralize scrolling in the virtual viewport, replacing App's direct scrollHeight writes. Preserve explicit follow toggle semantics: during an active turn follow-on stays at latest; follow-off never pulls the reader down; idle follows only at bottom; turning follow on immediately jumps to latest. Preserve the current 40px end threshold.
   - Use library measurement-aware end scrolling (verify installed API); no smooth scrolling while item sizes stream. Anchor follow-off to first visible item ID and pixel offset when content above changes, groups expand/collapse, or measurements correct. Avoid competing native browser and virtualizer anchoring.
   - Snapshot creates a fresh generation: cancel pending work, rebuild/replay atomically, invalidate old measurements/disclosure IDs. Follow-on initializes to latest; follow-off restores the closest clamped logical position without claiming cross-snapshot identity equivalence. Clear/new session empties caches and resets viewport.
   - Closed reasoning bodies are not mounted or parsed. Closed subagents omit children from the render-item sequence. Open visible Markdown retains existing createMemo; no parsing for offscreen rows and no unbounded HTML cache. Keep full original strings, do not truncate message content as a hidden optimization.
   - Keep the focused render item mounted as a bounded extra item through rangeExtractor; when collapsing a group containing focus, move focus to its header first. Test Tab/Shift+Tab and scrolling. Native find/select-all can only see mounted content; explicitly document this limitation. Full-history search/export is not in this task.

## Phase 3 — Streaming cadence and regression gates

5. Coalesce visual streaming safely (depends on step 2; may run parallel to step 3).
   - Add gui/src/conversation/eventQueue.ts for a browser-owned event scheduler, injected with a clock in tests. Apply ordered events in a Solid batch once per animation frame; combine only adjacent compatible token/reasoning events of identical scope and kind, never move events across tool/state/turn boundaries. Keep createStore.applyEvent synchronous for direct consumers/tests.
   - Flush pending events before applying non-stream boundary events. Snapshot/cleared are authoritative reset barriers: discard superseded pending old-generation events; never replay them afterward. Snapshot inflight replay finishes atomically before exposing the view.
   - Add a maximum queued-size/latency fallback for background tabs (rAF may stop), preserve every token and event ordering, flush on visibility transition, and dispose timers/listeners on teardown. Register subscription cleanup. Coalesce optimistic submit with queued work as needed so user messages cannot overtake pending output.
   - Markdown of a visible changing row updates at most once per scheduled flush, not once per original network delta. This bounds frequency, not complexity of one enormous Markdown document; do not claim otherwise.
6. Validate and document (depends on steps 3–5).
   - Extend test/guiStore.test.ts and add test/guiConversation.test.ts for stable structure, grouping, lifecycle, snapshot/clear reset, exact batched event equivalence and scheduler cleanup. Exercise reactive subscriptions in the actual browser too; Solid's server export under Bun is not sufficient evidence for browser effects.
   - Browser hard gates for a fixed 900px fixture: with >=24px fixture item heights and overscan 8, at most 64 mounted render items (including focused extra) at 100/1,000/10,000 history sizes; reopening the large subagent must obey the same bound. This is a render-item budget, not a universal cap on descendants inside arbitrarily large Markdown rows.
   - After settling, one live token must neither replace an unchanged mounted historical node nor parse historical Markdown; closed reasoning/subagent bodies have zero mounted descendants. Oldest/latest rows remain reachable; displayed text and ordering remain exact.
   - Test live growth, follow on/off, manual expansion surviving unmount, collapse above viewport, resize, images, keyboard focus, clear/new, authoritative snapshot and mid-turn reconnect with no duplicate tokens. Check anchor drift <=2px after layout settles where the same logical anchor still exists.
   - Performance goal on the recorded reference environment: p95 streamed visual-update work within one 60Hz frame (~16.7ms), input response <100ms, no steady-state >50ms tasks attributable to history-wide remount/layout in the standard fixture. Store as benchmark/report until stable rather than flaky cross-machine CI timing assertions. Capture before/after browser traces.
   - Root commands: bun run typecheck; bun test; bun run lint. GUI commands from c:\Projects\Harness\gui: bunx tsc --noEmit -p tsconfig.json; bun run build; bunx playwright install chromium; bun run test:browser. New test:browser script invokes Playwright through Bun. Confirm browser runner and Bun suite stay separate.
   - Update GUI spec performance/interaction sections and README with bounded-rendering behavior, history retention and native-find limitation. Keep architecture target notes aligned.

## Critical files

Existing modifications:

- c:\Projects\Harness\gui\src\store.ts — createStore, appendText, blocks, scope lifecycle and snapshot application.
- c:\Projects\Harness\gui\src\App.tsx — subscription, conversation rendering and follow controls.
- c:\Projects\Harness\gui\src\Markdown.tsx — reactive ItemContent, lazy ReasoningBlock, split/reuse subagent header/row rendering.
- c:\Projects\Harness\gui\src\styles.css — viewport, measured items, group/disclosure styling.
- c:\Projects\Harness\gui\package.json — GUI virtualizer, browser-test development dependency/scripts; update actual GUI lockfile generated by Bun, if present.
- c:\Projects\Harness\test\guiStore.test.ts — preserve/extend store semantics.
- c:\Projects\Harness\specs\gui\SPECIFICATION-v0.1.0.md and c:\Projects\Harness\README.md — behavior and verification documentation.
  New files:
- c:\Projects\Harness\gui\src\conversation\ConversationViewport.tsx
- c:\Projects\Harness\gui\src\conversation\viewModel.ts
- c:\Projects\Harness\gui\src\conversation\eventQueue.ts
- c:\Projects\Harness\gui\playwright.config.ts
- c:\Projects\Harness\gui\e2e\conversation.perf.spec.ts and mock fixture helper in the same folder
- c:\Projects\Harness\test\guiConversation.test.ts
  References only: c:\Projects\Harness\src\server\protocol.ts, translate.ts, server.ts; c:\Projects\Harness\gui\src\client.ts and types.ts.

## Boundaries and caveats

- Client-only rendering improvement. No server/protocol/provider/model/context-compaction changes, no configuration changes in c:\Users\mathm\.vise, no SDK migration.
- Do not discard history, impose last-N limits, use CSS hiding as the primary fix, or render all children when a subagent expands.
- Memory for retained source history and initial snapshot ingestion remains O(history). Single enormous Markdown-message parsing and browser maximum scroll-height limits are separate limits; report baseline findings, do not promise infinite-session scaling.
- No new full-history search, export, cross-snapshot server row IDs or general Markdown renderer rewrite. Native browser search and cross-offscreen selection limitations must be visible in documentation.

## References checked

Official TanStack Solid adapter and Virtualizer API documentation were fetched: https://tanstack.com/virtual/latest/docs/framework/solid/solid-virtual and https://tanstack.com/virtual/latest/docs/api/virtualizer. Confirm exact supported options against the installed package; do not assume newest documented chat anchoring APIs exist in an older version.
