import { describe, expect, test } from "bun:test";
import { createStore } from "../gui/src/store.js";
import {
  createViewModel,
  estimateItemSize,
} from "../gui/src/conversation/viewModel.js";
import {
  createEventQueue,
  type Clock,
} from "../gui/src/conversation/eventQueue.js";
import type { ServerEvent, UIState } from "../gui/src/types.js";

/**
 * These cover the client-side rendering model that the bounded viewport rests
 * on: a stable render-item sequence, disclosure state that outlives the
 * components it controls, and an event scheduler that changes *when* work
 * happens without changing what is displayed.
 *
 * Reactive effects are exercised in a real browser too (gui/e2e/): Solid's
 * server export under Bun proves the graph is wired, not that the DOM follows.
 *
 * Solid itself is never imported here — it resolves from `gui/node_modules`,
 * which is reachable from the GUI sources but not from `test/`. Where a test
 * needs to know whether a memo recomputed, it compares the returned array by
 * identity: a memo that did not re-run hands back the very same array.
 */

describe("conversation view model (v0.7.0 bounded rendering)", () => {
  test("a text-only change does not rebuild the render-item sequence", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([{ kind: "userMessage", text: "hi" }]));
    store.applyEvent(token("a "));

    const before = vm.items();
    const beforeIds = before.map((i) => i.id);

    // 1,000 deltas into the live row. The memo hands back the identical array,
    // so it did not recompute: no structural work was done for text.
    for (let i = 0; i < 1_000; i++) store.applyEvent(token(`t${i} `));
    expect(vm.items()).toBe(before);
    expect(vm.items().map((i) => i.id)).toEqual(beforeIds);

    // The text really did land.
    const row = store.rows()[1];
    expect(row.item.kind).toBe("assistantMessage");
    expect("text" in row.item && row.item.text.startsWith("a t0 t1 ")).toBe(
      true,
    );
    expect("text" in row.item && row.item.text.endsWith("t999 ")).toBe(true);

    // Appending a row *does* rebuild it, and only then.
    store.applyEvent(toolCall("read_file"));
    expect(vm.items()).not.toBe(before);
  });

  test("row and group identity are stable across 1,000 deltas", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([{ kind: "userMessage", text: "hi" }]));
    store.applyEvent({ type: "token", scope: sub("s1"), text: "x" });
    store.applyEvent(token("main "));

    const idsBefore = vm.items().map((i) => i.id);
    const rowsBefore = store.rows().map((r) => r.id);
    for (let i = 0; i < 1_000; i++) store.applyEvent(token(`d${i} `));
    expect(vm.items().map((i) => i.id)).toEqual(idsBefore);
    expect(store.rows().map((r) => r.id)).toEqual(rowsBefore);
  });

  test("appending a row leaves every earlier row's identity untouched", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot(historyItems(50)));
    const before = vm.items().map((i) => i.id);
    store.applyEvent(toolCall("read_file"));
    const after = vm.items().map((i) => i.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });

  test("a run's children are in the sequence only while it is expanded", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([]));
    for (let i = 0; i < 5; i++) {
      store.applyEvent({
        type: "toolCall",
        scope: sub("s1"),
        name: "t",
        args: { i },
      });
    }
    // Running: one header plus five children.
    let items = vm.items();
    expect(items[0].kind).toBe("header");
    expect(items.filter((i) => i.kind === "row")).toHaveLength(5);

    store.applyEvent(subagentEnd("s1"));
    // Completed: collapsed, so only the header remains in the sequence.
    items = vm.items();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("header");
  });

  test("appending to a collapsed run does not lengthen the sequence", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([]));
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    store.applyEvent(subagentEnd("s1"));
    expect(vm.items()).toHaveLength(1);
    // Rows keep arriving for the (now collapsed) scope; the flattened
    // sequence is unchanged because closed groups omit their children.
    const block = store.blocks()[0];
    expect(block.kind).toBe("subagent");
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    expect(vm.items()).toHaveLength(1);
  });

  test("a manual expansion stands until the run's lifecycle changes", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([]));
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    const group = () =>
      store.blocks()[0] as Extract<
        ReturnType<typeof store.blocks>[number],
        { kind: "subagent" }
      >;
    expect(vm.isGroupOpen(group())).toBe(true); // running

    vm.toggleGroup(group()); // the user collapses it mid-run
    expect(vm.isGroupOpen(group())).toBe(false);

    // More rows arrive: a text/structure update must not override the choice.
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    expect(vm.isGroupOpen(group())).toBe(false);

    // Completion is a genuine lifecycle transition, and it collapses.
    store.applyEvent(subagentEnd("s1"));
    expect(vm.isGroupOpen(group())).toBe(false);

    // Reopening by hand works, and the end of the turn must not undo it.
    vm.toggleGroup(group());
    expect(vm.isGroupOpen(group())).toBe(true);
    store.applyEvent({
      type: "turnEnd",
      answer: "",
      kind: "text",
      finished: true,
    });
    expect(vm.isGroupOpen(group())).toBe(true);
  });

  test("completion collapses a run the user had left open", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([]));
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    const group = () =>
      store.blocks()[0] as Extract<
        ReturnType<typeof store.blocks>[number],
        { kind: "subagent" }
      >;
    // Collapse then reopen: `manual` is set to true, matching the domain.
    vm.toggleGroup(group());
    vm.toggleGroup(group());
    expect(vm.isGroupOpen(group())).toBe(true);
    store.applyEvent(subagentEnd("s1"));
    // The lifecycle transition drops the override.
    expect(vm.isGroupOpen(group())).toBe(false);
  });

  test("reasoning disclosure follows the domain and survives manual toggles", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([]));
    store.applyEvent({
      type: "reasoning",
      scope: { kind: "main" },
      text: "hm",
    });
    const row = () => store.rows()[0];
    expect(vm.isReasoningOpen(row())).toBe(true); // streaming: open

    vm.toggleReasoning(row()); // the user closes it while it streams
    expect(vm.isReasoningOpen(row())).toBe(false);
    store.applyEvent({
      type: "reasoning",
      scope: { kind: "main" },
      text: " more",
    });
    expect(vm.isReasoningOpen(row())).toBe(false); // more text does not reopen

    // A token ends reasoning: the lifecycle transition governs again.
    store.applyEvent(token("answer"));
    expect(vm.isReasoningOpen(row())).toBe(false);
    vm.toggleReasoning(row());
    expect(vm.isReasoningOpen(row())).toBe(true); // reopened by hand
  });

  test("a new generation resets disclosure state and mints fresh ids", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot([]));
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    store.applyEvent(subagentEnd("s1"));
    const group = () =>
      store.blocks()[0] as Extract<
        ReturnType<typeof store.blocks>[number],
        { kind: "subagent" }
      >;
    vm.toggleGroup(group());
    expect(vm.isGroupOpen(group())).toBe(true);
    const idsBefore = vm.items().map((i) => i.id);

    store.applyEvent(snapshot([{ kind: "userMessage", text: "again" }]));
    const idsAfter = vm.items().map((i) => i.id);
    // Ids belong to a generation and are never reused across one.
    expect(idsAfter.some((id) => idsBefore.includes(id))).toBe(false);
    // The same scope key, in a new generation, starts from the domain default.
    store.applyEvent({
      type: "toolCall",
      scope: sub("s1"),
      name: "t",
      args: {},
    });
    expect(vm.isGroupOpen(group())).toBe(true); // running again
  });

  test("indexOf locates render items and reports -1 for unknown ids", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(snapshot(historyItems(10)));
    const items = vm.items();
    expect(vm.indexOf(items[7].id)).toBe(7);
    expect(vm.indexOf("nope")).toBe(-1);
  });

  test("size estimates are per item kind and never zero", () => {
    const store = createStore();
    const vm = createViewModel(store);
    store.applyEvent(
      snapshot([
        { kind: "userMessage", text: "hi" },
        { kind: "toolCall", name: "t", args: {} },
      ]),
    );
    const items = vm.items();
    expect(estimateItemSize(items[0])).toBeGreaterThan(
      estimateItemSize(items[1]),
    );
    expect(estimateItemSize(undefined)).toBeGreaterThan(0);
  });
});

describe("event queue (v0.7.0 streaming cadence)", () => {
  test("stream events are deferred to one frame and applied in order", () => {
    const clock = testClock();
    const applied: ServerEvent[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
    });
    queue.push(token("a "));
    queue.push(token("b "));
    expect(applied).toHaveLength(0); // nothing applied yet
    expect(queue.pending()).toBe(1); // and the two were merged

    clock.runFrame();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ type: "token", text: "a b " });
    queue.dispose();
  });

  test("coalescing never crosses scope, kind or a boundary event", () => {
    const clock = testClock();
    const applied: ServerEvent[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
    });
    queue.push(token("a "));
    queue.push({ type: "token", scope: sub("s1"), text: "s " }); // other scope
    queue.push(token("b "));
    queue.push({ type: "reasoning", scope: { kind: "main" }, text: "r " }); // other kind
    clock.runFrame();
    expect(applied.map((e) => (e as { text: string }).text)).toEqual([
      "a ",
      "s ",
      "b ",
      "r ",
    ]);
    queue.dispose();
  });

  test("a boundary event flushes what is pending, in order, at once", () => {
    const clock = testClock();
    const applied: ServerEvent[] = [];
    let batches = 0;
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => {
        batches += 1;
        return fn();
      },
      clock: clock.api,
    });
    queue.push(token("a "));
    queue.push(token("b "));
    queue.push(toolCall("read_file"));
    // The tool call is a boundary: everything before it is applied first, and
    // all of it lands in a single reactive batch.
    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ type: "token", text: "a b " });
    expect(applied[1]).toMatchObject({ type: "toolCall" });
    expect(batches).toBe(1);
    expect(clock.pendingFrames()).toBe(0); // the scheduled frame was cancelled
    queue.dispose();
  });

  test("a snapshot discards superseded pending events and never replays them", () => {
    const clock = testClock();
    const applied: ServerEvent[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
    });
    queue.push(token("stale "));
    const snap = snapshot([{ kind: "userMessage", text: "fresh" }]);
    queue.push(snap);
    expect(applied).toEqual([snap]);
    // Running the frame that the stale token scheduled must produce nothing.
    clock.runFrame();
    clock.runTimers();
    expect(applied).toEqual([snap]);
    queue.dispose();
  });

  test("`cleared` is a reset barrier too", () => {
    const clock = testClock();
    const applied: ServerEvent[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
    });
    queue.push(token("stale "));
    queue.push({ type: "cleared" });
    clock.runFrame();
    expect(applied).toEqual([{ type: "cleared" }]);
    queue.dispose();
  });

  test("a queue-size cap flushes when frames never come (background tab)", () => {
    const clock = testClock({ frames: false });
    const applied: ServerEvent[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
      maxQueued: 3,
    });
    // Distinct scopes so nothing coalesces and the queue really grows.
    queue.push({ type: "token", scope: sub("a"), text: "1" });
    queue.push({ type: "token", scope: sub("b"), text: "2" });
    expect(applied).toHaveLength(0);
    queue.push({ type: "token", scope: sub("c"), text: "3" });
    expect(applied).toHaveLength(3); // the cap forced a flush
    queue.dispose();
  });

  test("the latency timer flushes when frames never come", () => {
    const clock = testClock({ frames: false });
    const applied: ServerEvent[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
      maxLatencyMs: 250,
    });
    queue.push(token("a "));
    expect(applied).toHaveLength(0);
    clock.runTimers();
    expect(applied).toHaveLength(1);
    queue.dispose();
  });

  test("a local action cannot overtake output already queued", () => {
    const clock = testClock();
    const order: string[] = [];
    const queue = createEventQueue({
      apply: () => order.push("event"),
      batch: (fn) => fn(),
      clock: clock.api,
    });
    queue.push(token("a "));
    queue.pushAction(() => order.push("user message"));
    expect(order).toEqual(["event", "user message"]);
    queue.dispose();
  });

  test("dispose cancels timers, drops pending work and ignores later pushes", () => {
    const clock = testClock();
    const applied: ServerEvent[] = [];
    const stopped: string[] = [];
    const queue = createEventQueue({
      apply: (e) => applied.push(e),
      batch: (fn) => fn(),
      clock: clock.api,
      onVisibilityChange: () => () => stopped.push("visibility"),
    });
    queue.push(token("a "));
    expect(queue.pending()).toBe(1);
    queue.dispose();
    expect(queue.pending()).toBe(0);
    expect(stopped).toEqual(["visibility"]);
    expect(clock.pendingFrames()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    queue.push(token("b "));
    clock.runFrame();
    expect(applied).toHaveLength(0);
    queue.dispose();
  });

  test("coalescing does not mutate the caller's event objects", () => {
    const clock = testClock();
    const queue = createEventQueue({
      apply: () => {},
      batch: (fn) => fn(),
      clock: clock.api,
    });
    const first = token("a ");
    queue.push(first);
    queue.push(token("b "));
    clock.runFrame();
    expect((first as { text: string }).text).toBe("a ");
    queue.dispose();
  });

  test("batched application produces exactly the unbatched result", () => {
    const events: ServerEvent[] = [
      snapshot([{ kind: "userMessage", text: "go" }]),
      { type: "reasoning", scope: { kind: "main" }, text: "think " },
      { type: "reasoning", scope: { kind: "main" }, text: "more" },
      token("one "),
      token("two "),
      { type: "token", scope: sub("s1"), text: "sub-a " },
      { type: "token", scope: sub("s1"), text: "sub-b" },
      toolCall("read_file"),
      token("three"),
      subagentEnd("s1"),
    ];

    const direct = createStore();
    for (const e of events) direct.applyEvent(e);

    const queued = createStore();
    const clock = testClock();
    const queue = createEventQueue({
      apply: (e) => queued.applyEvent(e),
      clock: clock.api,
    });
    for (const e of events) queue.push(e);
    queue.flush();

    const shape = (s: ReturnType<typeof createStore>) =>
      s
        .rows()
        .map((r) => ({
          kind: r.item.kind,
          depth: r.depth,
          scope: r.scope,
          text: "text" in r.item ? r.item.text : undefined,
        }));
    expect(shape(queued)).toEqual(shape(direct));
    queue.dispose();
  });
});

// --- helpers ---------------------------------------------------------------

function testClock(options: { frames?: boolean } = {}) {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let next = 1;
  const api: Clock = {
    requestFrame: (cb) => {
      const handle = next++;
      if (options.frames !== false) frames.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle) => void frames.delete(handle),
    setTimer: (cb) => {
      const handle = next++;
      timers.set(handle, cb);
      return handle;
    },
    clearTimer: (handle) => void timers.delete(handle),
  };
  return {
    api,
    runFrame: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb();
    },
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const cb of pending) cb();
    },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
  };
}

function snapshot(history: unknown[]): ServerEvent {
  return {
    type: "snapshot",
    history: history as never,
    inflight: [],
    state: basicState() as never,
  };
}

function historyItems(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { kind: "userMessage", text: `user ${i}` }
      : { kind: "assistantMessage", text: `answer ${i}` },
  );
}

function token(text: string): ServerEvent {
  return { type: "token", scope: { kind: "main" }, text };
}

function toolCall(name: string): ServerEvent {
  return { type: "toolCall", scope: { kind: "main" }, name, args: {} };
}

function sub(id: string): { kind: "subagent"; id: string; depth: number } {
  return { kind: "subagent", id, depth: 1 };
}

function subagentEnd(id: string): ServerEvent {
  return { type: "subagentEnd", scope: sub(id), ok: true, label: id, depth: 1 };
}

function basicState(): UIState {
  return {
    activeProfile: "Agent",
    activeModel: "m",
    cwd: "/work",
    context: { promptTokens: null, maxContext: 8192 },
    profiles: [{ name: "Agent", origin: "builtin" }],
    models: [],
    skills: [],
    hooks: [],
    hooksEnabled: true,
    turnActive: false,
  };
}
