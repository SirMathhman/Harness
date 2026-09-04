import { describe, expect, test } from "bun:test";
import { searchCatalog } from "../src/tools/catalog.js";
import {
  CORE_TOOL_NAMES,
  makeCallToolTool,
  makeSearchToolsTool,
} from "../src/tools/metaTools.js";
import { buildToolRegistry } from "../src/tools/index.js";
import { readFileTool } from "../src/tools/fileTools.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Tool } from "../src/types.js";

function stubTool(name: string, description: string): Tool {
  return {
    name,
    description,
    mutating: false,
    parameters: { type: "object", properties: {} },
    handler: async () => "ok",
  };
}

describe("searchCatalog (spec §3.3.1)", () => {
  const tools = [
    stubTool("read_file", "Read the contents of a file."),
    stubTool("write_file", "Write content to a file."),
    stubTool("run_command", "Run a shell command and capture output."),
  ];

  test("a name match outranks a description-only match", () => {
    const matches = searchCatalog(tools, "read", 5);
    expect(matches[0].tool.name).toBe("read_file");
  });

  test("description tokens are matched", () => {
    const matches = searchCatalog(tools, "shell command", 5);
    expect(matches.map((m) => m.tool.name)).toContain("run_command");
  });

  test("no match returns an empty list", () => {
    expect(searchCatalog(tools, "zzzqqq", 5)).toEqual([]);
  });

  test("limit truncates results", () => {
    const many = [
      stubTool("a_one", "alpha"),
      stubTool("a_two", "alpha"),
      stubTool("a_three", "alpha"),
    ];
    expect(searchCatalog(many, "alpha", 2)).toHaveLength(2);
  });

  test("results are deterministic (score desc, then name asc)", () => {
    const many = [stubTool("b_tool", "shared"), stubTool("a_tool", "shared")];
    const names = searchCatalog(many, "shared", 5).map((m) => m.tool.name);
    expect(names).toEqual(["a_tool", "b_tool"]);
  });
});

describe("dynamic tool surface (spec §3.3.1)", () => {
  test("default mode advertises every tool", () => {
    const { registry } = buildToolRegistry({ ...DEFAULT_CONFIG });
    expect(registry.advertised().length).toBe(registry.all().length);
  });

  test("dynamic mode advertises only the constant surface", () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
      dynamicTools: true,
    });
    const advertised = registry.advertised().map((t) => t.name);
    const expected = [...CORE_TOOL_NAMES, "search_tools", "call_tool"];
    expect(advertised.sort()).toEqual([...expected].sort());
    // The full catalog is still present and dispatchable.
    expect(registry.all().length).toBeGreaterThan(advertised.length);
  });

  test("search_tools returns matching definitions as JSON", async () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
      dynamicTools: true,
    });
    const tool = makeSearchToolsTool(registry);
    const out = await tool.handler({ query: "read file" });
    const parsed = JSON.parse(out) as { name: string }[];
    expect(parsed.map((p) => p.name)).toContain("read_file");
  });

  test("search_tools with no match reports none", async () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
      dynamicTools: true,
    });
    const tool = makeSearchToolsTool(registry);
    const out = await tool.handler({ query: "zzzqqq" });
    expect(out).toContain("No tools matched");
  });

  test("call_tool dispatches to a real tool", async () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
      dynamicTools: true,
    });
    const tool = makeCallToolTool(registry, DEFAULT_CONFIG.maxToolOutputChars);
    const out = await tool.handler({
      name: "read_file",
      args: { path: "/definitely/does/not/exist.txt" },
    });
    // read_file on a missing file returns an error string (E1).
    expect(out).toContain("Error");
  });

  test("call_tool with an unknown tool returns an error string", async () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
      dynamicTools: true,
    });
    const tool = makeCallToolTool(registry, DEFAULT_CONFIG.maxToolOutputChars);
    const out = await tool.handler({ name: "nope", args: {} });
    expect(out).toContain("Unknown tool");
  });

  test("read_file is still directly callable in dynamic mode", async () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
      dynamicTools: true,
    });
    expect(registry.get("read_file")).toBe(readFileTool);
  });
});
