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
