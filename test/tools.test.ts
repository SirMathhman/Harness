import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
} from "../src/tools/fileTools.js";
import { searchTool, globToRegExp } from "../src/tools/search.js";
import { ToolRegistry, dispatch, validateArgs } from "../src/tools/registry.js";
import { executeToolCalls } from "../src/tools/execute.js";
import { finishTool } from "../src/tools/finish.js";
import type { Tool, ToolCall } from "../src/types.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "harness-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("file tools (AC 4)", () => {
  test("write_file creates parents and reports bytes", async () => {
    const p = path.join(dir, "a", "b", "c.txt");
    const out = await writeFileTool.handler({ path: p, content: "hello" });
    expect(out).toContain("5");
    expect((await readFileTool.handler({ path: p })).trim()).toBe("hello");
  });

  test("read_file missing file -> error (E1)", async () => {
    const out = await readFileTool.handler({
      path: path.join(dir, "nope.txt"),
    });
    expect(out).toContain("Error");
  });

  test("read_file line range", async () => {
    const p = path.join(dir, "lines.txt");
    writeFileSync(p, "l1\nl2\nl3\nl4\n");
    const out = await readFileTool.handler({
      path: p,
      startLine: 2,
      endLine: 3,
    });
    expect(out).toBe("l2\nl3");
  });

  test("edit_file exact match replaces", async () => {
    const p = path.join(dir, "edit.txt");
    writeFileSync(p, "foo bar foo");
    const out = await editFileTool.handler({
      path: p,
      oldString: "bar",
      newString: "baz",
    });
    expect(out).not.toContain("Error");
    expect((await readFileTool.handler({ path: p })).trim()).toBe(
      "foo baz foo",
    );
  });

  test("edit_file 0 matches -> error (E12)", async () => {
    const p = path.join(dir, "edit2.txt");
    writeFileSync(p, "abc");
    const out = await editFileTool.handler({
      path: p,
      oldString: "zzz",
      newString: "x",
    });
    expect(out).toContain("Error");
  });

  test("edit_file >1 match without replaceAll -> error (E12)", async () => {
    const p = path.join(dir, "edit3.txt");
    writeFileSync(p, "x x x");
    const out = await editFileTool.handler({
      path: p,
      oldString: "x",
      newString: "y",
    });
    expect(out).toContain("Error");
  });

  test("edit_file replaceAll replaces all", async () => {
    const p = path.join(dir, "edit4.txt");
    writeFileSync(p, "x x x");
    const out = await editFileTool.handler({
      path: p,
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });
    expect(out).not.toContain("Error");
    expect((await readFileTool.handler({ path: p })).trim()).toBe("y y y");
  });

  test("list_dir shows file/dir markers", async () => {
    const sub = path.join(dir, "ld");
    mkdirSync(sub);
    writeFileSync(path.join(sub, "f.txt"), "x");
    const out = await listDirTool.handler({ path: sub });
    expect(out).toContain("f.txt");
  });
});

describe("search tool (AC 4)", () => {
  test("globToRegExp matches", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a.txt")).toBe(false);
    expect(globToRegExp("**/x.js").test("a/b/x.js")).toBe(true);
  });

  test("text mode returns file:line:content", async () => {
    const p = path.join(dir, "search.txt");
    writeFileSync(p, "alpha\nbeta\n");
    const out = await searchTool.handler({
      pattern: "beta",
      mode: "text",
      path: dir,
      isRegexp: false,
    });
    expect(out).toContain("search.txt:2:beta");
  });

  test("glob mode returns matching paths", async () => {
    const out = await searchTool.handler({
      pattern: "*.txt",
      mode: "glob",
      path: dir,
    });
    expect(out).toContain(".txt");
  });
});

describe("registry & dispatch (AC 5, 6)", () => {
  test("validateArgs flags missing required", () => {
    const problems = validateArgs(
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
      {},
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  test("validateArgs number/integer symmetry", () => {
    // A number-typed param accepts both integer and float values.
    const numSchema = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    expect(validateArgs(numSchema, { n: 5 })).toHaveLength(0);
    expect(validateArgs(numSchema, { n: 5.5 })).toHaveLength(0);
    // An integer-typed param accepts integers but rejects floats.
    const intSchema = {
      type: "object",
      properties: { i: { type: "integer" } },
      required: ["i"],
    };
    expect(validateArgs(intSchema, { i: 5 })).toHaveLength(0);
    expect(validateArgs(intSchema, { i: 5.5 })).toHaveLength(1);
  });

  test("dispatch unknown tool -> error string (E2)", async () => {
    const reg = new ToolRegistry().register(finishTool);
    const res = await dispatch(
      reg,
      { id: "1", name: "nope", arguments: {} },
      1000,
    );
    expect(res.content).toContain("Unknown tool");
  });

  test("dispatch bad args -> error string (E2)", async () => {
    const reg = new ToolRegistry().register(finishTool);
    const res = await dispatch(
      reg,
      { id: "1", name: "finish", arguments: {} },
      1000,
    );
    expect(res.content).toContain("Invalid arguments");
  });

  test("dispatch handler exception -> error string (E1)", async () => {
    const boom: Tool = {
      name: "boom",
      mutating: false,
      description: "x",
      parameters: { type: "object", properties: {} },
      async handler() {
        throw new Error("kaboom");
      },
    };
    const reg = new ToolRegistry().register(boom);
    const res = await dispatch(
      reg,
      { id: "1", name: "boom", arguments: {} },
      1000,
    );
    expect(res.content).toContain("failed");
    expect(res.content).toContain("kaboom");
  });

  test("dispatch truncates long output (E14)", async () => {
    const big: Tool = {
      name: "big",
      mutating: false,
      description: "x",
      parameters: { type: "object", properties: {} },
      async handler() {
        return "x".repeat(5000);
      },
    };
    const reg = new ToolRegistry().register(big);
    const res = await dispatch(
      reg,
      { id: "1", name: "big", arguments: {} },
      100,
    );
    expect(res.content.length).toBeLessThanOrEqual(100 + 50);
  });
});

describe("execution ordering (AC 11)", () => {
  test("returns results in original order", async () => {
    const mk = (name: string, mutating: boolean, delay: number): Tool => ({
      name,
      mutating,
      description: "x",
      parameters: { type: "object", properties: {} },
      async handler() {
        await new Promise((r) => setTimeout(r, delay));
        return name;
      },
    });
    const reg = new ToolRegistry()
      .register(mk("m1", true, 10))
      .register(mk("r1", false, 30))
      .register(mk("m2", true, 10))
      .register(mk("r2", false, 30));
    const calls: ToolCall[] = [
      { id: "1", name: "m1", arguments: {} },
      { id: "2", name: "r1", arguments: {} },
      { id: "3", name: "m2", arguments: {} },
      { id: "4", name: "r2", arguments: {} },
    ];
    const results = await executeToolCalls(reg, calls, 1000);
    expect(results.map((r) => r.content)).toEqual(["m1", "r1", "m2", "r2"]);
  });

  test("mutating tools run sequentially", async () => {
    const order: string[] = [];
    const mk = (name: string, mutating: boolean): Tool => ({
      name,
      mutating,
      description: "x",
      parameters: { type: "object", properties: {} },
      async handler() {
        order.push(`start-${name}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end-${name}`);
        return name;
      },
    });
    const reg = new ToolRegistry()
      .register(mk("m1", true))
      .register(mk("m2", true));
    const calls: ToolCall[] = [
      { id: "1", name: "m1", arguments: {} },
      { id: "2", name: "m2", arguments: {} },
    ];
    await executeToolCalls(reg, calls, 1000);
    // m1 must fully finish before m2 starts.
    expect(order.indexOf("end-m1")).toBeLessThan(order.indexOf("start-m2"));
  });
});
