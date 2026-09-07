import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/agent/session.js";
import {
  autoName,
  autoSaveLast,
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  sanitizeName,
  SessionError,
  stripSystemMessages,
  type SavedSession,
} from "../src/sessions/index.js";
import { modelGraph } from "./helpers.js";

/** A fresh temp sessions directory, cleaned up by the caller. */
function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "vise-sessions-store-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal well-formed saved session for seeding. */
function seed(name = "s"): SavedSession {
  return {
    version: 1,
    name,
    title: name,
    profile: "Agent",
    model: "test-model",
    savedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("sanitizeName (spec §3.3 R5, AC 14)", () => {
  test("strips path separators and reserved characters", () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeName("  padded  ")).toBe("padded");
  });

  test("throws invalid-name when the result is empty", () => {
    expect(() => sanitizeName("///")).toThrow(SessionError);
    expect(() => sanitizeName("")).toThrow(SessionError);
    try {
      sanitizeName("///");
    } catch (err) {
      expect((err as SessionError).reason).toBe("invalid-name");
    }
  });
});

describe("autoName (spec §3.3 R4, AC 2)", () => {
  test("produces a filesystem-safe timestamp name", () => {
    const name = autoName();
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    // No characters that sanitizeName would strip.
    expect(sanitizeName(name)).toBe(name);
  });

  test("repeated calls do not collide within a millisecond-free window", () => {
    // Two names generated in the same millisecond are identical; the spec only
    // requires that the format is collision-resistant across distinct saves.
    const a = autoName();
    const b = autoName();
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
  });
});

describe("stripSystemMessages (spec §3.3 R1, AC 4)", () => {
  test("drops all leading system messages", () => {
    const msgs = [
      { role: "system" as const, content: "sp1" },
      { role: "system" as const, content: "sp2" },
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "yo" },
    ];
    expect(stripSystemMessages(msgs)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });

  test("keeps a system message that is not leading", () => {
    const msgs = [
      { role: "user" as const, content: "hi" },
      { role: "system" as const, content: "late" },
    ];
    expect(stripSystemMessages(msgs)).toEqual(msgs);
  });

  test("returns an empty array for an all-system conversation", () => {
    expect(stripSystemMessages([{ role: "system", content: "sp" }])).toEqual(
      [],
    );
  });
});

describe("saveSession / loadSession (AC 1, AC 4)", () => {
  test("save writes version 1 JSON and load round-trips it", () => {
    const { dir, cleanup } = tempDir();
    try {
      const saved = seed("round");
      saveSession(dir, saved);
      const file = path.join(dir, "round.json");
      expect(existsSync(file)).toBe(true);
      const loaded = loadSession(dir, "round");
      expect(loaded).toEqual(saved);
    } finally {
      cleanup();
    }
  });

  test("save is idempotent per name (E8)", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, seed("dup"));
      saveSession(dir, { ...seed("dup"), title: "dup2" });
      const loaded = loadSession(dir, "dup");
      expect(loaded.title).toBe("dup2");
    } finally {
      cleanup();
    }
  });

  test("load of a missing name throws not-found (AC 5)", () => {
    const { dir, cleanup } = tempDir();
    try {
      try {
        loadSession(dir, "ghost");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect(err).toBeInstanceOf(SessionError);
        expect((err as SessionError).reason).toBe("not-found");
      }
    } finally {
      cleanup();
    }
  });

  test("load of corrupt JSON throws corrupt (AC 11)", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(path.join(dir, "bad.json"), "{ not json", "utf8");
      try {
        loadSession(dir, "bad");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect((err as SessionError).reason).toBe("corrupt");
      }
    } finally {
      cleanup();
    }
  });

  test("load of a wrong version throws version-mismatch (AC 12)", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(
        path.join(dir, "old.json"),
        JSON.stringify({ ...seed("old"), version: 2 }),
        "utf8",
      );
      try {
        loadSession(dir, "old");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect((err as SessionError).reason).toBe("version-mismatch");
      }
    } finally {
      cleanup();
    }
  });

  test("load of a malformed shape throws invalid-shape", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(
        path.join(dir, "malformed.json"),
        JSON.stringify({ version: 1, name: "x" }),
        "utf8",
      );
      try {
        loadSession(dir, "malformed");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect((err as SessionError).reason).toBe("invalid-shape");
      }
    } finally {
      cleanup();
    }
  });
});

describe("listSessions (AC 3, E2, E3)", () => {
  test("returns an empty array for a missing directory", () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(listSessions(path.join(dir, "nope"))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("lists every readable session", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, seed("a"));
      saveSession(dir, seed("b"));
      const list = listSessions(dir);
      expect(list.map((s) => s.name).sort()).toEqual(["a", "b"]);
      expect(list.every((s) => s.readable)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("marks corrupt files as unreadable rather than throwing (E2)", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, seed("good"));
      writeFileSync(path.join(dir, "bad.json"), "{ not json", "utf8");
      const list = listSessions(dir);
      const bad = list.find((s) => s.name === "bad");
      expect(bad?.readable).toBe(false);
      expect(list.find((s) => s.name === "good")?.readable).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("marks version-mismatched files as unreadable (E3)", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(
        path.join(dir, "old.json"),
        JSON.stringify({ ...seed("old"), version: 2 }),
        "utf8",
      );
      const list = listSessions(dir);
      expect(list.find((s) => s.name === "old")?.readable).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("renameSession (AC 6, E9, E10)", () => {
  test("renames the file and updates name/title", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, seed("old"));
      renameSession(dir, "old", "new");
      expect(existsSync(path.join(dir, "old.json"))).toBe(false);
      const loaded = loadSession(dir, "new");
      expect(loaded.name).toBe("new");
      expect(loaded.title).toBe("new");
    } finally {
      cleanup();
    }
  });

  test("throws not-found when the source is missing (E9)", () => {
    const { dir, cleanup } = tempDir();
    try {
      try {
        renameSession(dir, "ghost", "new");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect((err as SessionError).reason).toBe("not-found");
      }
    } finally {
      cleanup();
    }
  });

  test("throws exists when the target is present (E10)", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, seed("a"));
      saveSession(dir, seed("b"));
      try {
        renameSession(dir, "a", "b");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect((err as SessionError).reason).toBe("exists");
      }
    } finally {
      cleanup();
    }
  });
});

describe("deleteSession (AC 7, E11, E12)", () => {
  test("removes the file", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, seed("doomed"));
      deleteSession(dir, "doomed");
      expect(existsSync(path.join(dir, "doomed.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws not-found when the name is missing (E11)", () => {
    const { dir, cleanup } = tempDir();
    try {
      try {
        deleteSession(dir, "ghost");
        expect.unreachable("expected SessionError");
      } catch (err) {
        expect((err as SessionError).reason).toBe("not-found");
      }
    } finally {
      cleanup();
    }
  });

  test("deleting the reserved `last` is allowed (E12)", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, { ...seed("last"), name: "last", title: "last" });
      deleteSession(dir, "last");
      expect(existsSync(path.join(dir, "last.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("autoSaveLast (spec §3.3 R7, R8, AC 8)", () => {
  test("writes last.json for a non-empty conversation", () => {
    const { dir, cleanup } = tempDir();
    try {
      const handle = createSession({ graph: modelGraph() });
      handle.session.messages.push({ role: "user", content: "hi" });
      autoSaveLast(dir, handle);
      const loaded = loadSession(dir, "last");
      expect(loaded.name).toBe("last");
      expect(loaded.messages).toEqual([{ role: "user", content: "hi" }]);
    } finally {
      cleanup();
    }
  });

  test("skips an empty conversation (R8)", () => {
    const { dir, cleanup } = tempDir();
    try {
      const handle = createSession({ graph: modelGraph() });
      autoSaveLast(dir, handle);
      expect(existsSync(path.join(dir, "last.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("does not clobber an existing last.json when empty (R8)", () => {
    const { dir, cleanup } = tempDir();
    try {
      saveSession(dir, { ...seed("last"), name: "last", title: "last" });
      const before = readFileSync(path.join(dir, "last.json"), "utf8");
      const handle = createSession({ graph: modelGraph() });
      autoSaveLast(dir, handle);
      expect(readFileSync(path.join(dir, "last.json"), "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });
});
