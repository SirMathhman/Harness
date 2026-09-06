# AGENTS.md — the Vise GUI

Guidance for AI coding agents working in `gui/`. The root `AGENTS.md` covers the
harness; this file covers the browser client, and in particular the **bounded
conversation rendering** added in v0.7.0.

Read the "Five invariants" section before changing anything under
`src/conversation/`, `src/store.ts` or `src/Markdown.tsx`. Every one of them can
be broken by a change that looks correct, passes `tsc`, passes `bun run test`,
and still silently restores O(history) rendering — the exact problem this code
exists to solve. The tests that catch each one are named below.

---

## 1. What this client is

A SolidJS + Vite single-page app that talks to the agent-server over one
WebSocket. It has no router, no state library and no CSS framework.

```
src/
  main.tsx        Entry: render(<App/>)
  App.tsx         Shell: topbar controls, sidebar panels, input bar, wiring
  client.ts       WebSocket transport: connect, backoff reconnect, subscribe/send
  types.ts        Hand-mirrored copy of src/server/protocol.ts (NOT the source of truth)
  store.ts        Protocol events -> conversation rows + blocks + UI state
  Markdown.tsx    Presentational pieces: Markdown, Row, ReasoningBlock, SubagentHeader
  styles.css      All styling, light/dark via [data-theme]
  conversation/
    viewModel.ts             blocks -> flat render-item list + disclosure state
    ConversationViewport.tsx the virtual viewport (scrolling, anchoring, focus)
    eventQueue.ts            animation-frame scheduler for incoming events
e2e/
  fixture.ts               mock-WebSocket harness + protocol fixture builders
  conversation.perf.spec.ts Playwright browser tests (the hard gates)
  report/                  generated timing report (gitignored)
playwright.config.ts
```

### Data flow

```
WebSocket frame
      |
      v
client.ts  subscribe(listener)
      |
      v
eventQueue.push(event)          <-- defers token/reasoning to one animation frame,
      |                             merges adjacent same-scope/same-kind runs,
      |                             flushes on every other event type
      v
store.applyEvent(event)         <-- SYNCHRONOUS. Path writes into a solid-js/store.
      |
      +--> doc.rows[]           flat, append-only within a generation
      +--> doc.blocks[]         maintained incrementally beside rows
      +--> ui.active{}          reasoning-open facts, keyed by row index
      |
      v
viewModel.items()               <-- memo: blocks (+ disclosure) -> flat RenderItem[]
      |                             reads STRUCTURE ONLY, never a row's text
      v
ConversationViewport            <-- @tanstack/solid-virtual mounts ~20-30 items
      |
      v
Row / SubagentHeader            <-- read row text reactively through props
```

The one-way rule: **the store never knows about the view model, and the view
model never knows about the DOM.** If you find yourself wanting the store to
know whether something is visible, you are about to break invariant #2.

---

## 2. Five invariants

These are the load-bearing constraints. Each says what it is, why it exists,
what breaking it looks like, and which test fails.

### Invariant 1 — a text delta must be a path write

`store.appendText` does exactly one thing:

```ts
setRowText("rows", index, "item", "text", (prev) => prev + text);
```

**Why.** `solid-js/store` notifies only the subscribers of that exact path. The
row object, the rows array, the block that contains the row and every other
row's identity are all untouched, so nothing above the changed row re-renders
and no historical Markdown is re-parsed.

**How it breaks.** Any of these restores full-history remounting:

```ts
setDoc("rows", [...doc.rows]);                      // copies the array
setDoc("rows", i, { ...row, item: {...} });         // replaces the row object
setDoc("rows", i, "item", { ...row.item, text });   // replaces the item object
setRows(rows().map(r => r === row ? next : r));     // the old signal-based shape
```

The last one is what the pre-v0.7.0 code did, and it is why a single token used
to remount the entire conversation: Solid's `For` keys by item identity, so a
fresh wrapper object for every row means every row's subtree is destroyed and
rebuilt.

**Symptom.** Streaming gets slower the longer the conversation is. Scroll
position jumps. Reasoning blocks snap shut on every token. CPU pegs during a
stream.

**Test.** `test/guiStore.test.ts` — *"a streamed delta does not replace the rows
array or any row"* asserts `store.rows()`, `store.rows()[1]` and
`store.blocks()` are the *same objects* after 1,000 deltas.

### Invariant 2 — the view model reads structure, never text

`viewModel.ts`'s `items` memo may read `block.kind`, `block.id`, `block.done`,
`block.depth`, `block.items` (only for expanded runs), `row.id`, `row.index`,
`row.depth`. It must **never** read `row.item.text`.

**Why.** The memo is a subscriber. Reading a row's text subscribes the whole
flattened sequence to that text, so every token would rebuild the render-item
list — and with it every virtual key, every measurement and every mounted row.

**Note the deliberate exception.** `ConversationViewport.tailLength` *does* read
text — but only of the **last** render item, and it is a separate memo feeding
only the auto-scroll effect. That is the one text subscription the view layer is
allowed, and it exists because a row growing while the reader is scrolled away is
never mounted, so it is never measured and the follow effect would otherwise
never fire. Do not generalise it.

**How it breaks.** Adding a preview/summary to a group header
(`block.items[0].row.item.text.slice(0, 40)`), or estimating a row's height from
its text length in `estimateItemSize`. Both look harmless.

**Symptom.** Same as invariant 1, but harder to see: the store is fine, and the
*sequence* is what churns. Look for `items()` returning a new array on every
token.

**Test.** `test/guiConversation.test.ts` — *"a text-only change does not rebuild
the render-item sequence"* asserts `vm.items()` returns the **identical array**
(`toBe`) after 1,000 deltas. A memo that re-ran hands back a new array, so this
is a direct check.

### Invariant 3 — a closed group must not read its children

In the `items` memo:

```ts
const open = resolve(groups, groupId, !block.done);
if (!open) continue;              // <-- do not touch block.items past here
const children = block.items;     // only reached when expanded
```

**Why.** Reading `block.items` subscribes the sequence to that array. A collapsed
subagent that is still receiving rows would rebuild the whole flattened list on
every appended row, for content nobody can see.

The header still needs the child count for its label — that read lives in the
`GroupHeader` component (`props.header.block.items.length`), which is mounted
only when the header is on screen, so the cost is bounded.

**Test.** `test/guiConversation.test.ts` — *"appending to a collapsed run does
not lengthen the sequence"*.

### Invariant 4 — disclosure state lives outside the components it controls

Expand/collapse state for subagent runs and reasoning blocks lives in two plain
`Map`s inside `createViewModel`, keyed by run id / row id.

**Why.** Virtualized rows unmount when they scroll out of view. State held in a
row component (a `createSignal` inside `ReasoningBlock`, or a `<details>`
element's own `open` property) is destroyed on scroll, so a group the user
opened by hand would silently snap shut the moment it left the window.

**The resolution rule** (`resolve()` in `viewModel.ts`) is deliberately subtle:

- The **domain fact** governs by default — `!block.done` for a run,
  `store.isActive(row.index)` for reasoning.
- A **manual toggle** sets an override that stands while the domain fact is
  unchanged.
- When the domain fact **transitions**, the override is dropped and the domain
  wins again. That is what makes "a run collapses when it completes" beat "the
  user had opened it", which matches the old `createEffect(() => node.open =
  !done)` behaviour exactly.

**The reactivity trap.** Because the state lives in plain `Map`s, reading it is
*not* reactive on its own. Both readers must therefore subscribe explicitly:

```ts
const isGroupOpen = (block: GroupBlock): boolean => {
  disclosureTick();                        // manual toggles
  return resolve(groups, block.id, !block.done);   // domain changes (block.done)
};
```

Take the **block**, not the id. An earlier version took `groupId: string` and
looked the entry up in the `Map` — which meant a completed run's header kept
rendering `aria-expanded="true"` forever, because nothing subscribed to `done`.
This was a real shipped bug, caught only in the browser.

**Test.** `test/guiConversation.test.ts` — *"a manual expansion stands until the
run's lifecycle changes"* and *"completion collapses a run the user had left
open"*. The reactive half is covered in `e2e/` (*"completion collapses a run and
the end of the turn does not reopen it"*), because a Bun test cannot see that an
attribute failed to update.

### Invariant 5 — ids are per-generation and never reused

`store.ts` mints `g{generation}:r{sequence}` per row; a group run's id is
`sub@{first row id}`; a render item's header id is `h:{group id}`.

**Why.**

- The virtualizer keys its measurement cache by `getItemKey`. Reusing an id for
  a different row hands it a stale height.
- The view model keys disclosure state by id. Reusing one leaks a user's
  expand/collapse choice into an unrelated row.
- A **snapshot is authoritative** and replaces the conversation wholesale. The
  protocol carries no persistent row identity, and this code must not invent
  cross-snapshot matching from text. Bumping the generation makes that explicit:
  no id can survive a reset, so nothing can be wrongly matched across one.

A scope may own **several** adjacent runs (a subagent's rows can be interrupted
by main-agent rows and resume later). That is why a run's id derives from its
first row, not from the scope key — the scope alone cannot identify a group.

**Test.** `test/guiStore.test.ts` — *"a snapshot or clear starts a new generation
with fresh ids"*, *"each adjacent run of a scope gets its own block id"*.

---

## 3. Traps that have already bitten

Every one of these cost real debugging time. They are listed with the symptom
first, because that is how you will meet them.

### 3.1 Nothing renders at all — Solid's `<template>` has a null `defaultView`

**Symptom.** The spacer has a sensible height (so `count` and `getTotalSize()`
are right), but `getVirtualItems()` is empty and zero `.vitem` elements exist.
`virtualizer.scrollRect` is `{width: 0, height: 0}` even though the container is
809px tall. `virtualizer.targetWindow` is `null`.

**Cause.** Solid builds its DOM inside a `<template>` element and clones it in.
Elements in a template's *content document* have
`ownerDocument.defaultView === null`. `@tanstack/virtual-core`'s `_willUpdate`
reads that to find its target window:

```js
this.targetWindow = this.scrollElement.ownerDocument.defaultView;
...
observeElementRect(instance, cb) {
  if (!instance.targetWindow) return;   // <-- silently installs NOTHING
}
```

So handing the virtualizer its scroll element from a **`ref` callback** — which
fires before the tree is adopted into the live document — permanently disables
both the resize observer and the scroll observer. No error, no warning.

**The fix, which must not be "simplified" away:**

```ts
let scrollerEl!: HTMLElement;
const [scroller, setScroller] = createSignal<HTMLElement | null>(null);
onMount(() => setScroller(scrollerEl));   // NOT ref={(el) => setScroller(el)}
...
<section class="conversation" ref={scrollerEl}>
```

`ref={scrollerEl}` (assigning the variable) is fine — it is *publishing the
signal* that must wait for mount.

**How to confirm in 10 seconds:**

```js
const v = /* the virtualizer */;
({ targetWindow: !!v.targetWindow, scrollRect: v.scrollRect, range: v.range })
// targetWindow false + scrollRect {0,0} + range null  ==>  this bug
```

### 3.2 GUI tests pass but assert nothing — Bun resolves solid-js's SSR build

**Symptom.** View-model tests return empty arrays. `createMemo` never recomputes.
Store path writes appear to do nothing reactively.

**Cause.** `solid-js`'s `exports` map lists `worker`, `browser`, `deno`, `node` —
and Bun matches `node`, which points at `dist/server.js`, the **non-reactive SSR
build**. Signals do not track, memos compute once, stores are plain objects.

**The fix.** The root `test` script passes `--conditions=browser`:

```json
"test": "bun test --conditions=browser"
```

**Always use `bun run test`, never bare `bun test`.** `bunfig.toml` does *not*
support a `conditions` key (tried, at top level and under `[test]`; neither is
honoured), so the flag has to live in the script.

**How to confirm.** If `createMemo` in a Bun test never re-runs, this is why.

### 3.3 `bun test` collects Playwright specs

Bun 1.3 **does** match `*.spec.ts`, contrary to a common assumption. Left alone,
`bun test` picks up `gui/e2e/conversation.perf.spec.ts`, which imports
`@playwright/test` from `gui/node_modules` and fails to resolve from the root.

`bunfig.toml` confines discovery:

```toml
[test]
root = "test"
```

Verified: this keeps `bun test`, `bun test <path>` and `bun test <filter>` all
working while excluding `gui/e2e/`. If you add tests outside `test/`, they will
be silently skipped — put them in `test/`.

### 3.4 `solid-js/store` path types cannot narrow a union

`ConversationItem` and `Block` are discriminated unions, so TypeScript rejects
`setDoc("rows", i, "item", "text", ...)` — `Part<ConversationItem, "kind">` does
not admit `"text"`.

`store.ts` handles this with three narrowly-typed aliases (`setRowText`,
`setGroupItem`, `setGroupDone`) that cast the setter once, at the top, with the
exact path each call site uses. **Do not** replace them with a blanket
`as any` setter, and do not "fix" the union by flattening it — the guards
immediately above each call site are what make the casts sound.

### 3.5 Auto-scroll stalls when the reader is far from the bottom

**Symptom.** With follow on during an active turn, the view pins to the latest
output — until the user scrolls up, after which it never catches up again.

**Cause.** A row growing off-screen is not mounted, so it is never measured, so
`getTotalSize()` never changes, so the `growth` signal never fires. The follow
effect has no dependency to wake it.

**Fix.** `tailLength` — a memo over the **last** render item's text length. See
invariant 2's exception.

The follow effect needs all three dependencies, and all three are load-bearing:

```ts
void items().length;   // a new row appeared
void tailLength();     // the newest row grew (may be off-screen)
void growth();         // a measurement corrected a mounted row
```

### 3.6 `anchorTo: "end"` is required for anchoring *at all*

It reads like "stick to the bottom", but in `@tanstack/virtual-core` it is the
gate on the whole key-anchor mechanism:

```js
if (prevOptions !== undefined && ... && merged.anchorTo === "end" && ...) {
  // capture first-visible item key + offset, restore after the update
}
```

With `anchorTo: "start"` there is **no anchoring**, and a reader gets thrown
around whenever content above them changes size. Keep it `"end"` and express
follow/no-follow through `followOnAppend` instead, which is what the code does:

```ts
get followOnAppend() { return props.follow() ? "instant" as const : false; }
```

`"instant"`, never `"smooth"`: item sizes are still streaming in and a smooth
animation chases a moving target.

### 3.7 Native scroll anchoring fights the virtualizer

`.conversation` sets `overflow-anchor: none`. Without it the browser's own scroll
anchoring and the virtualizer both correct `scrollTop`, and they cancel or
compound unpredictably. Do not remove it.

### 3.8 The measured box is the item, padding included

`.vitem` uses `padding-bottom: 0.6rem` rather than a flex `gap` on the container,
because `measureElement` reads `borderBoxSize` — padding is measured, margins and
gaps are not. `.conversation` must therefore **not** be `display: flex`, and
`.vitem` must not gain a margin. If rows start overlapping or drifting apart as
you scroll, check for a margin or a gap that crept back in.

### 3.9 `measureElement` needs `data-index` before it runs

`indexFromElement` reads the `data-index` attribute. The ref callback runs before
Solid has necessarily applied it, hence:

```tsx
ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
```

Do not "clean this up" into a direct call.

### 3.10 `getVirtualItems()` is a store reconciled by `index`

`@tanstack/solid-virtual` returns a `solid-js/store` array reconciled with
`{ key: "index" }`. That means the object for a given virtual index keeps its
identity across updates, so `<For>` moves DOM nodes instead of recreating them —
which is what keeps a visible row mounted while you scroll. Consequences:

- Feed **`items()[virtualRow.index]`** through an accessor and read it inside the
  child, so the row updates in place when indices shift (e.g. a group above
  expands). Do not destructure it at the top of the `For` callback.
- Do not add a `key` prop to the `For` over virtual items, and do not map them
  into fresh wrapper objects first — that reintroduces per-scroll remounting.

### 3.11 Focus events do not fire when the document is unfocused

If you drive the page from a browser-extension/automation context,
`element.focus()` updates `document.activeElement` but Chrome does **not**
dispatch `focus`/`focusin` until the document regains focus. A test asserting
focus retention will look broken when it is not. Dispatch synthetically to check
the logic:

```js
el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
```

Playwright's `locator.focus()` does not have this problem.

---

## 4. Debugging recipe

The fastest loop is the real app in a real browser with a mock socket. It found
every bug the Bun tests could not.

### 4.1 Start the dev server

```bash
cd gui && bunx vite --port 5173 --strictPort
```

`/ws` proxies to the agent-server on 8787. You do **not** need one — the client
fails to connect, then reconnects with backoff, and picks up the mock below on
its next attempt.

### 4.2 Paste this harness into the browser console

```js
(() => {
  const sockets = [];
  class MockWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 0); }
    send(d) { (window.__sent ||= []).push(d); }
    close() { this.readyState = 3; this.onclose && this.onclose({}); }
    addEventListener() {} removeEventListener() {}
  }
  window.WebSocket = MockWebSocket;
  window.__emit = (events) => { for (const e of events) { const f = JSON.stringify(e);
    for (const s of sockets) s.onmessage && s.onmessage({ data: f }); } };
  window.__state = (turnActive = false) => ({ activeProfile: "Agent", activeModel: "m",
    cwd: "/work", context: { promptTokens: 120, maxContext: 8192 },
    profiles: [{ name: "Agent", origin: "builtin" }],
    models: [{ name: "m", baseUrl: "u", providerName: null }],
    skills: [], hooks: [], hooksEnabled: true, turnActive });
  window.__history = (n) => { const h = [];
    for (let i = 0; i < n; i++) {
      if (i % 4 === 0) h.push({ kind: "userMessage", text: "user " + i });
      else if (i % 4 === 1) h.push({ kind: "assistantMessage",
        text: "### answer " + i + "\n\nSome **markdown**:\n\n- one\n- two" });
      else if (i % 4 === 2) h.push({ kind: "toolCall", name: "read_file",
        args: { path: "f" + i + ".ts" } });
      else h.push({ kind: "toolResult", name: "read_file", ok: true,
        summary: "read f" + i + ".ts" });
    } return h; };
  window.__settle = async (n = 2) => { for (let i = 0; i < n; i++)
    await new Promise(r => requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(r, 30)))); };
  window.__probe = () => {
    const conv = document.querySelector(".conversation");
    const items = [...document.querySelectorAll(".vitem")];
    const heights = items.map(n => n.getBoundingClientRect().height);
    return { conn: document.querySelector(".conn")?.textContent, vitems: items.length,
      minH: heights.length ? Math.round(Math.min(...heights)) : 0,
      indices: items.map(n => +n.getAttribute("data-index")).sort((a,b)=>a-b),
      scrollTop: Math.round(conv.scrollTop), scrollH: conv.scrollHeight,
      clientH: conv.clientHeight,
      distFromEnd: Math.round(conv.scrollHeight - conv.scrollTop - conv.clientHeight),
      first: items[0]?.innerText.slice(0, 40),
      last: items[items.length - 1]?.innerText.slice(0, 40) };
  };
  window.__setFollow = async (on) => { const b = document.querySelector(".follow-toggle");
    if (b.textContent.includes("on") !== on) b.click(); await window.__settle(); };
  window.__scrollUntil = async (sel) => { const conv = document.querySelector(".conversation");
    conv.scrollTop = 0; await window.__settle(1);
    for (let i = 0; i < 200; i++) { const el = document.querySelector(sel); if (el) return el;
      conv.scrollTop += 400; await window.__settle(1); } return null; };
  return "installed";
})()
```

Then wait ~4s for the reconnect and drive it:

```js
window.__emit([{ type: "snapshot", history: window.__history(10000),
                 inflight: [], state: window.__state(true) }]);
await window.__settle();
window.__probe()
```

### 4.3 Temporarily expose the virtualizer

When the viewport itself misbehaves, add this line inside `ConversationViewport`
(Vite HMR picks it up; **remove it before committing**):

```ts
(window as unknown as { __virt: unknown }).__virt = virtualizer;
(window as unknown as { __items: unknown }).__items = items;
```

Then:

```js
const v = window.__virt;
({ count: v.options.count, targetWindow: !!v.targetWindow, scrollRect: v.scrollRect,
   scrollOffset: v.scrollOffset, range: v.range, total: v.getTotalSize(),
   virtualItems: v.getVirtualItems().length, measurements: v.measurementsCache.length,
   unsubs: v.unsubs.length, items: window.__items().length })
```

### 4.4 Failure signatures

| What you see | Likely cause |
|---|---|
| Spacer has height, 0 `.vitem`, `scrollRect {0,0}`, `targetWindow` null | §3.1 — scroll element published from `ref` instead of `onMount` |
| `items()` length 0 in a Bun test, memos never recompute | §3.2 — missing `--conditions=browser` |
| Mounted count grows without bound as you scroll | `rangeExtractor` returning too much, or a `For` that isn't over `getVirtualItems()` |
| Streaming slows as history grows; historical nodes mutate | Invariant 1 or 2 broken |
| Header label updates but the caret / `aria-expanded` does not | Invariant 4 — a disclosure reader that isn't subscribed |
| A user's expansion snaps shut on scroll | Invariant 4 — state moved back into a component |
| Reader jumps when a group above expands/collapses | §3.6 — `anchorTo` no longer `"end"` |
| Rows overlap or drift apart while scrolling | §3.8 — a margin/gap outside the measured border box |
| Follow works, then stalls after scrolling up | §3.5 — `tailLength` dependency removed |
| Scroll position fights itself, jitters | §3.7 — `overflow-anchor` removed |

### 4.5 Proving a historical node was untouched

This is the check that a streamed token did not disturb the history:

```js
const marked = [...document.querySelectorAll(".vitem")][2];
const id = marked.getAttribute("data-item-id");
const beforeHTML = marked.innerHTML;
let mutations = 0;
const mo = new MutationObserver(rs => { mutations += rs.length; });
mo.observe(marked, { subtree: true, childList: true, characterData: true, attributes: true });

const evs = []; for (let i = 0; i < 400; i++)
  evs.push({ type: "token", scope: { kind: "main" }, text: "live" + i + " " });
window.__emit(evs); await window.__settle(3);
mutations += mo.takeRecords().length; mo.disconnect();

({ sameNode: document.querySelector(`[data-item-id="${id}"]`) === marked,
   mutations, htmlUnchanged: marked.innerHTML === beforeHTML })
// want: { sameNode: true, mutations: 0, htmlUnchanged: true }
```

Do this with **follow off**, scrolled to the end and then back up ~300px, so the
"stay pinned while the bottom grows" path cannot scroll the marked row out of the
window and confuse the result.

---

## 5. Tests: what covers what

### Bun (`test/`, run with `bun run test` from the repo root)

| File | Covers |
|---|---|
| `test/guiStore.test.ts` | Event application, grouping, scope lifecycle, snapshot/inflight replay, row identity and generations, `done` stickiness |
| `test/guiConversation.test.ts` | Render-item sequence stability, collapsed-group behaviour, disclosure resolution rules, event-queue coalescing/boundaries/reset barriers/cleanup |

Bun tests can assert the reactivity *graph* (with `--conditions=browser`) but not
the DOM. They cannot catch "an attribute failed to update".

### Playwright (`gui/e2e/`, run with `bun run test:browser` from `gui/`)

```bash
cd gui
bun run test:browser:install   # once — downloads Chromium
bun run test:browser
bunx playwright test -g "part of a test name"   # single test
```

Covers what only a real layout engine can: the mounted-item budget, scroll and
anchor behaviour, focus retention, measurement correction (images, resize),
and that closed bodies mount nothing.

`e2e/fixture.ts` exposes protocol builders (`snapshot`, `history`, `tokens`,
`subagentRun`, `interleavedSubagents`) and page helpers (`openApp`, `emit`,
`scrollTo`, `scrollUntil`, `scrollToHeader`, `setFollow`, `totalHeight`,
`mountedItems`).

**Two fixture lessons worth keeping:**

- Only mounted content is in the DOM. A test that wants to click a subagent
  header must `scrollToHeader(page)` first; asserting on `.subagent-toggle`
  right after emitting events fails whenever the view is following the bottom.
- Use `totalHeight(page)` (the spacer) rather than `scrollHeight` when asserting
  measurement changes — `scrollHeight` is clamped to the client height and hides
  the change for short content.

### The hard gate

At most **64 mounted render items** on a 900px viewport, with items ≥24px and
`overscan: 8`, at 100 / 1,000 / 10,000 rows of history *and* with a 3,000-row
subagent run re-expanded. Measured on the reference machine: 18–19 and 27.

This is a budget on **render items**, not DOM nodes. One enormous Markdown
message is still one render item, with as many descendants as its content needs.
Do not restate the gate as a cap on descendants.

### Timing

Timings are **recorded, not asserted** — absolute thresholds are machine-specific
and would be flaky in CI. A run writes `gui/e2e/report/conversation-perf.json`.
Reference numbers (Windows, Chromium, 1280×900):

```
10,000-row snapshot ingest   413 ms   (O(history) by design)
600 streamed deltas           65 ms   0 long tasks
mounted at 10,000 rows        18-19
3,000-child run re-expanded   27
```

---

## 6. Change recipes

### Adding a new `ConversationItem` kind

1. `src/server/protocol.ts` **and** `gui/src/types.ts` — the GUI copy is mirrored
   by hand and the protocol is additive-only.
2. `Markdown.tsx` `ItemContent` — add a `<Match when={ofKind(props.item, "…")}>`.
   Read every field through the accessor (`it().foo`), never via a captured
   local.
3. `viewModel.ts` `estimateItemSize` — add a rough height. Base it on the item
   **kind**, never on its text (invariant 2).
4. `styles.css` — the row gets `row-{kind}` automatically.

### Adding a new event type

1. Protocol + `gui/src/types.ts`.
2. `store.ts` `applyEvent` — add a case. Keep it synchronous.
3. `eventQueue.ts` — decide whether it is a *stream* event (deferrable,
   coalescable) or a *boundary* (flushes immediately). Anything that changes
   structure, lifecycle or state is a boundary. `isBoundary` currently defines
   stream events as exactly `token` and `reasoning`; leave it that way unless the
   new event is genuinely a high-frequency text delta.
4. If it is a new authoritative reset, add it to `isReset` **and** to
   `resetGeneration` handling in the store.

### Changing how rows are grouped

Grouping is "maximal run of consecutive same-scope rows", maintained incrementally
in `store.ts` `linkBlock` using the shadow variables `blockCount`, `tailScope`,
`tailItems`. Those exist so appending never has to *read* the store (a read
inside a tracking scope would create a spurious subscription).

If you change grouping, you must keep: incremental maintenance, per-run ids, and
`scopeBlocks` (which lets `subagentEnd` flip `done` on every run of that scope
without scanning). Rebuilding the block list from scratch on each append is the
easy wrong answer — it is O(history) per row.

### Changing follow / scroll behaviour

All of it lives in `ConversationViewport`. The four rules, and where each is
implemented:

| Rule | Implementation |
|---|---|
| Active turn + follow on → stay at latest, even if scrolled up | the `createEffect` reading `items().length`, `tailLength()`, `growth()` |
| Idle + follow on → follow only while at the bottom | `followOnAppend` + `scrollEndThreshold: 40` |
| Follow off → never move the reader | `followOnAppend: false` |
| Turning follow on → jump to latest immediately | `createEffect(on(props.follow, …, { defer: true }))` |

The 40px end threshold is the pre-existing behaviour; keep it.

### Touching the virtualizer options

Re-read §3.6 and §3.10 first. Reactive options must be **getters** on the options
object (`get count()`, `get followOnAppend()`, `get rangeExtractor()`) — a plain
value is read once and never updates, because `@tanstack/solid-virtual` re-reads
the merged props inside a `createComputed`.

Pin the version. This code is written against `@tanstack/solid-virtual@3.13.37`;
`scrollToEnd`, `isAtEnd(threshold)`, `anchorTo` and `followOnAppend` all exist
there. Verify against the installed package before using anything newer — the
docs describe versions this project may not have.

---

## 7. Boundaries — what this work deliberately does not do

Do not "improve" these without being asked; each was an explicit decision.

- **No server, protocol, provider or model changes.** This is a client-side
  rendering concern. `src/server/protocol.ts` stays the source of truth and
  `gui/src/types.ts` mirrors it by hand.
- **History is never discarded.** No last-N cap, no eviction, no truncation of
  message text as a hidden optimization. Offscreen rows are *not rendered*; they
  are not hidden with CSS either.
- **No cross-snapshot row identity.** The protocol has none, and inferring it
  from text would be a guess. A snapshot starts a fresh generation, and a
  scrolled-up reader is clamped to the closest logical position rather than
  pretending an anchor survived.
- **No expansion history in `localStorage`.** Disclosure state is per-session and
  resets on a new snapshot or clear. `localStorage` holds only the theme.
- **No full-history search or export.** Consequently, native find-in-page and
  select-all see only mounted content. This limitation is documented in
  `README.md` and the GUI spec, and must stay documented if you touch it.
- **No debug endpoint in the shipped app.** The browser tests replace the
  WebSocket transport instead.
- **Known remaining limits.** Snapshot ingestion and retained memory are
  O(history). A single enormous Markdown message costs what it costs to parse
  once per flush — the queue bounds *frequency*, not the cost of one parse. The
  browser's maximum scroll height is a separate ceiling. Do not claim infinite
  session scaling.

---

## 8. Commands

From the repo root:

```bash
bun run typecheck     # tsc over src/ only — does NOT cover gui/
bun run test          # Bun suite; must be `bun run`, see §3.2
bun run lint          # eslint, covers gui/ too
```

From `gui/`:

```bash
bunx tsc --noEmit -p tsconfig.json   # covers src/, e2e/, and both configs
bun run build                        # vite build -> gui/dist (what the server serves)
bun run test:browser                 # Playwright
bunx vite --port 5173 --strictPort   # dev server for the manual loop in §4
```

After any change under `src/conversation/`, `store.ts` or `Markdown.tsx`, run
**all** of them. The Bun suite alone will not tell you the viewport is broken —
it did not, when the viewport rendered nothing at all.
