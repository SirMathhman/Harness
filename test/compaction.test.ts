import { describe, expect, test } from "bun:test";
import {
  shouldCompact,
  findKeepBoundary,
  partitionForCompaction,
  applyRecap,
  truncateCompaction,
} from "../src/context/compaction.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Config, Message } from "../src/types.js";

const cfg: Config = { ...DEFAULT_CONFIG, model: "m" };

describe("compaction (AC 8)", () => {
  test("shouldCompact is false below threshold", () => {
    expect(shouldCompact(100, cfg)).toBe(false);
  });

  test("shouldCompact is true above threshold", () => {
    // threshold 0.8 * 8192 = 6553.6
    expect(shouldCompact(7000, cfg)).toBe(true);
  });

  test("shouldCompact is false when tokens unknown", () => {
    expect(shouldCompact(null, cfg)).toBe(false);
  });

  test("findKeepBoundary keeps the last N messages", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "a2" },
    ];
    expect(findKeepBoundary(msgs, 2)).toBe(3);
  });

  test("findKeepBoundary does not split tool_calls from results", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", name: "read_file", arguments: {} }],
      },
      { role: "tool", tool_call_id: "1", name: "read_file", content: "r1" },
      { role: "tool", tool_call_id: "1", name: "read_file", content: "r2" },
      { role: "assistant", content: "done" },
    ];
    // keep=2 naively lands the boundary on a `tool` message (index 4), which
    // would orphan that result from its tool_calls message. The walk-back must
    // move the boundary to the assistant tool_calls message (index 2).
    const boundary = findKeepBoundary(msgs, 2);
    expect(boundary).toBe(2);
    // The kept slice must not start with a `tool` message.
    expect(msgs[boundary].role).not.toBe("tool");
  });

  test("partitionForCompaction splits system/older/recent", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "a2" },
    ];
    const { system, older, recent } = partitionForCompaction(msgs, {
      ...cfg,
      compactKeepMessages: 2,
    });
    expect(system).toHaveLength(1);
    expect(recent).toHaveLength(2);
    expect(older).toHaveLength(2);
  });

  test("applyRecap rebuilds [system, recap, recent]", () => {
    const system: Message[] = [{ role: "system", content: "s" }];
    const recent: Message[] = [{ role: "user", content: "2" }];
    const out = applyRecap(system, "the recap", recent);
    expect(out[0].role).toBe("system");
    expect(out[1].content).toContain("the recap");
    expect(out[2].content).toBe("2");
  });

  test("truncateCompaction drops older messages", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "a2" },
    ];
    const out = truncateCompaction(msgs, { ...cfg, compactKeepMessages: 2 });
    expect(out).toHaveLength(3); // system + 2 recent
    expect(out[0].role).toBe("system");
  });
});
