import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Tool } from "../types.js";
import { looksBinary, resolvePath } from "../utils.js";

/** read_file (spec §3.3 #1). */
export const readFileTool: Tool = {
  name: "read_file",
  mutating: false,
  description: "Read the contents of a file, optionally a line range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file." },
      startLine: {
        type: "integer",
        description: "1-based start line (optional).",
      },
      endLine: {
        type: "integer",
        description: "1-based inclusive end line (optional).",
      },
    },
    required: ["path"],
  },
  async handler(args) {
    const p = resolvePath(String(args.path));
    if (!existsSync(p)) return `Error: file not found: ${p}`;
    const st = statSync(p);
    if (st.isDirectory()) return `Error: ${p} is a directory, not a file.`;
    const buf = readFileSync(p);
    if (looksBinary(buf))
      return `Notice: ${p} appears to be a binary file; not displaying contents.`;
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const start =
      typeof args.startLine === "number" ? Math.max(1, args.startLine) : 1;
    const end =
      typeof args.endLine === "number"
        ? Math.min(lines.length, args.endLine)
        : lines.length;
    if (start > lines.length)
      return `Error: startLine ${start} is beyond end of file (${lines.length} lines).`;
    const selected = lines.slice(start - 1, end);
    return selected.map((line, i) => `${start + i}: ${line}`).join("\n");
  },
};

/** write_file (spec §3.3 #2). */
export const writeFileTool: Tool = {
  name: "write_file",
  mutating: true,
  description:
    "Write content to a file, creating parent directories as needed. Overwrites existing files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write." },
      content: { type: "string", description: "Full content to write." },
    },
    required: ["path", "content"],
  },
  async handler(args) {
    const p = resolvePath(String(args.path));
    const content = String(args.content);
    try {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    } catch (err) {
      return `Error writing ${p}: ${(err as Error).message}`;
    }
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}.`;
  },
};

/** edit_file (spec §3.3 #3). */
export const editFileTool: Tool = {
  name: "edit_file",
  mutating: true,
  description:
    "Replace an exact string in a file. Fails if oldString matches 0 or >1 times unless replaceAll is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      oldString: { type: "string", description: "Exact text to find." },
      newString: { type: "string", description: "Text to replace it with." },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences (default false).",
      },
    },
    required: ["path", "oldString", "newString"],
  },
  async handler(args) {
    const p = resolvePath(String(args.path));
    if (!existsSync(p)) return `Error: file not found: ${p}`;
    const oldString = String(args.oldString);
    const newString = String(args.newString);
    const replaceAll = args.replaceAll === true;
    if (oldString.length === 0) return "Error: oldString must be non-empty.";
    const text = readFileSync(p, "utf8");
    const count = countOccurrences(text, oldString);
    if (count === 0) return `Error: oldString not found in ${p}.`;
    if (count > 1 && !replaceAll) {
      return `Error: oldString matched ${count} times in ${p}; pass replaceAll=true to replace all.`;
    }
    const updated = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    writeFileSync(p, updated, "utf8");
    return `Edited ${p} (${replaceAll ? count : 1} replacement${count === 1 ? "" : "s"}).`;
  },
};

/** list_dir (spec §3.3 #4). */
export const listDirTool: Tool = {
  name: "list_dir",
  mutating: false,
  description: "List directory entries, each marked as file or directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the directory." },
      recursive: {
        type: "boolean",
        description: "Recurse into subdirectories (default false).",
      },
    },
    required: ["path"],
  },
  async handler(args) {
    const p = resolvePath(String(args.path));
    if (!existsSync(p)) return `Error: directory not found: ${p}`;
    const st = statSync(p);
    if (!st.isDirectory()) return `Error: ${p} is not a directory.`;
    const recursive = args.recursive === true;
    const lines: string[] = [];
    const walk = (dir: string, prefix: string) => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const isDir = entry.isDirectory();
        lines.push(`${prefix}${entry.name}${isDir ? "/" : ""}`);
        if (recursive && isDir) walk(path.join(dir, entry.name), prefix + "  ");
      }
    };
    walk(p, "");
    if (lines.length === 0) return "(empty directory)";
    return lines.join("\n");
  },
};

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
