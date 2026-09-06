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
