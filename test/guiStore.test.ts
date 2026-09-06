import { describe, expect, test } from "bun:test";
import { createStore } from "../gui/src/store.js";
import type { ServerEvent } from "../gui/src/types.js";

describe("gui store (GUI spec §3.8, §4.11)", () => {
  test("AC 16: an unrecognized event type is ignored without error", () => {
    const store = createStore();
    const before = store.rows().length;
    // An unknown/forward-compatible event type must be tolerated.
    store.applyEvent({
      type: "serverEvent",
      name: "future-feature",
      payload: { everything: "is fine" },
    } as unknown as ServerEvent);
    store.applyEvent({
      type: "completelyUnknownType",
      anything: true,
    } as unknown as ServerEvent);
    // Snapshot reconstitution, then verify neither crashed nor polluted rows.
    const snap = snapshot([{ kind: "userMessage", text: "hi" }], basicState());
    store.applyEvent(snap);
    expect(store.rows().length).toBe(1);
    expect(store.rows()[0].item.kind).toBe("userMessage");
    expect(store.rows().length).toBeGreaterThanOrEqual(before);
  });

  test("a snapshot rebuilds rows and state", () => {
    const store = createStore();
    store.applyEvent(
      snapshot(
        [
          { kind: "userMessage", text: "hello" },
          { kind: "assistantMessage", text: "world" },
        ],
        basicState(),
      ),
    );
    expect(store.rows()).toHaveLength(2);
    expect(store.rows()[0].item.kind).toBe("userMessage");
    expect(store.rows()[1].item.kind).toBe("assistantMessage");
    expect(store.state()?.activeProfile).toBe("Agent");
  });

  test("pushUserMessage appends the user's task optimistically (spec §3.8)", () => {
    const store = createStore();
    store.pushUserMessage("my task");
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0].item).toEqual({
      kind: "userMessage",
      text: "my task",
    });
  });

  test("state patches merge partial updates", () => {
    const store = createStore();
    store.applyEvent(snapshot([], basicState()));
    store.applyEvent({ type: "state", patch: { hooksEnabled: false } });
    expect(store.state()?.hooksEnabled).toBe(false);
    // Active profile from the snapshot is retained.
    expect(store.state()?.activeProfile).toBe("Agent");
  });

  test("isActive tracks the open reasoning block (GUI spec §3.9)", () => {
    const store = createStore();
    store.applyEvent({
      type: "reasoning",
      scope: { kind: "main" },
      text: "hmm",
    });
    expect(store.isActive(0)).toBe(true); // reasoning row is open
    store.applyEvent({
      type: "token",
      scope: { kind: "main" },
      text: "answer",
    });
    expect(store.isActive(0)).toBe(false); // a token after reasoning collapses it
    store.applyEvent({
      type: "reasoning",
      scope: { kind: "main" },
      text: "more",
    });
    expect(store.isActive(2)).toBe(true); // new reasoning row (index 2) is open
    store.applyEvent({
      type: "toolCall",
      scope: { kind: "main" },
      name: "t",
      args: {},
    });
    expect(store.isActive(2)).toBe(false); // toolCall clears it
  });

  test("a main-agent token does not collapse a subagent's open reasoning block", () => {
    const store = createStore();
    const sub = { kind: "sub" as const, id: "s1" };
    store.applyEvent({ type: "reasoning", scope: sub, text: "sub thinks" });
    const subIdx = store.rows().length - 1;
    expect(store.isActive(subIdx)).toBe(true);
    // A main-agent token arrives while the subagent is still reasoning.
    store.applyEvent({ type: "token", scope: { kind: "main" }, text: "main" });
    // The subagent's reasoning block stays open; only the main scope is affected.
    expect(store.isActive(subIdx)).toBe(true);
  });

  test("two subagent reasoning blocks at different depths are both open", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1" };
    const s2 = { kind: "sub" as const, id: "s2" };
    store.applyEvent({ type: "reasoning", scope: s1, text: "a" });
    const idx1 = store.rows().length - 1;
    store.applyEvent({ type: "reasoning", scope: s2, text: "b" });
    const idx2 = store.rows().length - 1;
    expect(store.isActive(idx1)).toBe(true);
    expect(store.isActive(idx2)).toBe(true);
    // A token from s1 closes only s1's block, leaving s2's open.
    store.applyEvent({ type: "token", scope: s1, text: "a-answer" });
    expect(store.isActive(idx1)).toBe(false);
    expect(store.isActive(idx2)).toBe(true);
  });

  test("interleaved same-depth subagent tokens each stay in one row", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1" };
    const s2 = { kind: "sub" as const, id: "s2" };
    // Two subagents at the same depth interleave (the default: spawn_subagent
    // is concurrent). Each scope's text must land in a single row, not
    // fragment across rows as the "last row" moves between scopes.
    store.applyEvent({ type: "token", scope: s1, text: "a1 " });
    store.applyEvent({ type: "token", scope: s2, text: "b1 " });
    store.applyEvent({ type: "token", scope: s1, text: "a2 " });
    store.applyEvent({ type: "token", scope: s2, text: "b2 " });
    // Two rows total (one per scope), not four.
    expect(store.rows()).toHaveLength(2);
    expect(store.rows()[0].item).toEqual({
      kind: "assistantMessage",
      text: "a1 a2 ",
    });
    expect(store.rows()[1].item).toEqual({
      kind: "assistantMessage",
      text: "b1 b2 ",
    });
  });

  test("a subagent block is open while running and collapses on completion", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    store.applyEvent({ type: "token", scope: s1, text: "hi " });
    // Running: the scope's block is open (not done).
    expect(store.blocks()).toHaveLength(1);
    expect(store.blocks()[0]).toMatchObject({ kind: "subagent", done: false });
    expect(store.isSubagentOpen("sub:s1")).toBe(true);
    // Stream more tokens while running.
    store.applyEvent({ type: "token", scope: s1, text: "there" });
    // Completion: the block flips to done (collapsed).
    store.applyEvent({
      type: "subagentEnd",
      scope: s1,
      ok: true,
      label: "done",
      depth: 1,
    });
    const blocks = store.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "subagent", done: true });
    expect(store.isSubagentOpen("sub:s1")).toBe(false);
  });

  test("a failed subagent also collapses on completion", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    store.applyEvent({ type: "token", scope: s1, text: "work" });
    expect(store.isSubagentOpen("sub:s1")).toBe(true);
    store.applyEvent({
      type: "subagentEnd",
      scope: s1,
      ok: false,
      label: "failed",
      depth: 1,
    });
    const blocks = store.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "subagent", done: true });
    // The final systemNotice row carries the outcome.
    const rows = store.rows();
    expect(rows[rows.length - 1].item.kind).toBe("systemNotice");
  });

  test("sequential subagents at the same depth each render one collapsing block", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    const s2 = { kind: "sub" as const, id: "s2", depth: 1 };
    store.applyEvent({ type: "token", scope: s1, text: "a1 " });
    store.applyEvent({ type: "token", scope: s1, text: "a2 " });
    // s1 completes; its single block collapses.
    store.applyEvent({
      type: "subagentEnd",
      scope: s1,
      ok: true,
      label: "done",
      depth: 1,
    });
    let blocks = store.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "subagent", done: true });
    // s2 starts after; it is a fresh block that is open (not done).
    store.applyEvent({ type: "toolCall", scope: s2, name: "t", args: {} });
    blocks = store.blocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: "subagent", done: false });
    expect(store.isSubagentOpen("sub:s1")).toBe(false);
    expect(store.isSubagentOpen("sub:s2")).toBe(true);
    store.applyEvent({
      type: "subagentEnd",
      scope: s2,
      ok: true,
      label: "done",
      depth: 1,
    });
    expect(store.blocks()[1]).toMatchObject({ kind: "subagent", done: true });
    expect(store.isSubagentOpen("sub:s2")).toBe(false);
  });

  test("rows of one scope grouping into a single in-order block", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    // Same scope interleaving across rows still groups consecutive runs (the
    // block stays grouped when its rows are adjacent; order is preserved).
    store.applyEvent({ type: "token", scope: s1, text: "a1 " });
    store.applyEvent({ type: "toolCall", scope: s1, name: "t", args: {} });
    store.applyEvent({
      type: "toolResult",
      scope: s1,
      name: "t",
      ok: true,
      summary: "ok",
    });
    store.applyEvent({ type: "token", scope: s1, text: "a2 " });
    // All rows are s1's: a single adjacent run -> one block.
    expect(store.blocks()).toHaveLength(1);
    expect(store.blocks()[0]).toMatchObject({ kind: "subagent", done: false });
    // All its rows live in the block, in order.
    const items = store.blocks()[0].items;
    expect(items.map((b) => b.row.item.kind)).toEqual([
      "assistantMessage", // a1
      "toolCall",
      "toolResult",
      "assistantMessage", // a2
    ]);
  });

  test("a streamed delta does not replace the rows array or any row", () => {
    const store = createStore();
    store.applyEvent(snapshot([{ kind: "userMessage", text: "hi" }], basicState()));
    store.applyEvent({ type: "token", scope: { kind: "main" }, text: "a" });
    const rowsBefore = store.rows();
    const rowBefore = rowsBefore[1];
    const blocksBefore = store.blocks();
    const idsBefore = rowsBefore.map((r) => r.id);

    // The hot path: 1,000 deltas must be path writes into one row's text.
    for (let i = 0; i < 1000; i++) {
      store.applyEvent({ type: "token", scope: { kind: "main" }, text: "x" });
    }
    expect(store.rows()).toBe(rowsBefore);
    expect(store.rows()[1]).toBe(rowBefore);
    expect(store.blocks()).toBe(blocksBefore);
    expect(store.rows().map((r) => r.id)).toEqual(idsBefore);
    expect(store.rows()[1].item).toEqual({
      kind: "assistantMessage",
      text: "a" + "x".repeat(1000),
    });
  });

  test("row ids are stable, ordered and unique within a generation", () => {
    const store = createStore();
    store.applyEvent(snapshot([], basicState()));
    store.applyEvent({ type: "token", scope: { kind: "main" }, text: "a" });
    store.applyEvent({ type: "toolCall", scope: { kind: "main" }, name: "t", args: {} });
    const ids = store.rows().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(store.rows().map((r) => r.index)).toEqual([0, 1]);
  });

  test("a snapshot or clear starts a new generation with fresh ids", () => {
    const store = createStore();
    const first = store.generation();
    store.applyEvent(snapshot([{ kind: "userMessage", text: "one" }], basicState()));
    const second = store.generation();
    expect(second).toBeGreaterThan(first);
    const idsBefore = store.rows().map((r) => r.id);

    store.applyEvent({ type: "cleared" });
    expect(store.generation()).toBeGreaterThan(second);
    expect(store.rows()).toHaveLength(0);
    expect(store.blocks()).toHaveLength(0);

    store.applyEvent(snapshot([{ kind: "userMessage", text: "two" }], basicState()));
    const idsAfter = store.rows().map((r) => r.id);
    // Ids carry their generation, so an id can never be reused for a
    // different row after an authoritative reset.
    expect(idsAfter.some((id) => idsBefore.includes(id))).toBe(false);
  });

  test("each adjacent run of a scope gets its own block id", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    store.applyEvent({ type: "token", scope: s1, text: "a" });
    store.applyEvent({ type: "token", scope: { kind: "main" }, text: "main" });
    store.applyEvent({ type: "toolCall", scope: s1, name: "t", args: {} });
    const blocks = store.blocks();
    // Two separate runs of the same scope: one scope, two groups, two ids.
    const subs = blocks.filter((b) => b.kind === "subagent");
    expect(subs).toHaveLength(2);
    expect(subs[0].id).not.toBe(subs[1].id);
    expect(subs[0].scope).toBe(subs[1].scope);
  });

  test("subagentEnd marks every run of that scope done", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    store.applyEvent({ type: "token", scope: s1, text: "a" });
    store.applyEvent({ type: "token", scope: { kind: "main" }, text: "main" });
    store.applyEvent({ type: "toolCall", scope: s1, name: "t", args: {} });
    store.applyEvent({
      type: "subagentEnd",
      scope: s1,
      ok: true,
      label: "done",
      depth: 1,
    });
    for (const block of store.blocks()) {
      if (block.kind === "subagent") expect(block.done).toBe(true);
    }
  });

  test("the end of the turn does not reopen a completed subagent", () => {
    const store = createStore();
    const s1 = { kind: "sub" as const, id: "s1", depth: 1 };
    store.applyEvent({ type: "token", scope: s1, text: "a" });
    store.applyEvent({
      type: "subagentEnd",
      scope: s1,
      ok: true,
      label: "done",
      depth: 1,
    });
    expect(store.blocks()[0]).toMatchObject({ kind: "subagent", done: true });
    store.applyEvent({
      type: "turnEnd",
      answer: "",
      kind: "text",
      finished: true,
    });
    // `done` is sticky for the generation: finishing the main turn must not
    // spring every completed group back open.
    expect(store.blocks()[0]).toMatchObject({ kind: "subagent", done: true });
    expect(store.isSubagentOpen("sub:s1")).toBe(false);
  });

  test("turnEnd closes any open reasoning block", () => {
    const store = createStore();
    store.applyEvent({ type: "reasoning", scope: { kind: "main" }, text: "hm" });
    expect(store.isActive(0)).toBe(true);
    store.applyEvent({
      type: "turnEnd",
      answer: "",
      kind: "text",
      finished: true,
    });
    expect(store.isActive(0)).toBe(false);
    expect(store.activeReasoning().size).toBe(0);
  });

  test("a snapshot's in-flight events are replayed once, after the history", () => {
    const store = createStore();
    store.applyEvent({
      type: "snapshot",
      history: [{ kind: "userMessage", text: "go" }] as never,
      inflight: [
        { type: "token", scope: { kind: "main" }, text: "partial " },
        { type: "token", scope: { kind: "main" }, text: "answer" },
      ] as never,
      state: basicState() as never,
    });
    expect(store.rows()).toHaveLength(2);
    expect(store.rows()[1].item).toEqual({
      kind: "assistantMessage",
      text: "partial answer",
    });
  });

  test("main-agent rows are not wrapped in a subagent block", () => {
    const store = createStore();
    store.applyEvent(
      snapshot([{ kind: "userMessage", text: "hi" }], basicState()),
    );
    store.applyEvent({ type: "token", scope: { kind: "main" }, text: "ok" });
    const blocks = store.blocks();
    // Both rows are plain `row` blocks, not `subagent`.
    expect(blocks.every((b) => b.kind === "row")).toBe(true);
  });
});

function snapshot(history: unknown[], state: unknown): ServerEvent {
  return {
    type: "snapshot",
    history: history as never,
    inflight: [],
    state: state as never,
  };
}

function basicState() {
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
