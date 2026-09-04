import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Tool } from "../types.js";
import { looksBinary, resolvePath, truncate } from "../utils.js";

/**
 * Convert a glob pattern to a RegExp. Supports `*` (any except /), `?` (single
 * char except /), and `**` (any path segment). Sufficient for filename matching.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * search (spec §3.3 #5).
 * - text mode: matching `file:line:content` lines.
 * - glob mode: matching file paths.
 */
export const searchTool: Tool = {
  name: "search",
  mutating: false,
  description:
    "Search files. mode=text matches line contents (regex or literal); mode=glob matches file paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern." },
      mode: {
        type: "string",
        enum: ["text", "glob"],
        description: "Search mode.",
      },
      path: {
        type: "string",
        description: "Root path to search (default cwd).",
      },
      includePattern: {
        type: "string",
        description: "Glob to filter which files to search (text mode).",
      },
      isRegexp: {
        type: "boolean",
        description: "Treat pattern as regex in text mode (default true).",
      },
    },
    required: ["pattern", "mode"],
  },
  async handler(args) {
    const pattern = String(args.pattern);
    const mode = String(args.mode);
    const root = resolvePath(String(args.path ?? process.cwd()));
    if (!existsSync(root)) return `Error: path not found: ${root}`;

    if (mode === "glob") {
      const re = globToRegExp(pattern);
      const matches: string[] = [];
      walk(root, (rel) => {
        if (re.test(rel) || re.test(path.basename(rel))) matches.push(rel);
      });
      return truncate(matches.join("\n") || "(no matches)", 20000);
    }

    if (mode === "text") {
      const isRegexp = args.isRegexp !== false;
      let matcher: (line: string) => boolean;
      try {
        matcher = isRegexp
          ? (line) => new RegExp(pattern).test(line)
          : (line) => line.includes(pattern);
      } catch (err) {
        return `Error: invalid regex pattern: ${(err as Error).message}`;
      }
      const includeRe = args.includePattern
        ? globToRegExp(String(args.includePattern))
        : null;
      const lines: string[] = [];
      walk(root, (rel, abs) => {
        if (includeRe && !includeRe.test(rel)) return;
        let st;
        try {
          st = statSync(abs);
        } catch {
          return;
        }
        if (!st.isFile()) return;
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch {
          return;
        }
        if (looksBinary(buf)) return;
        const content = buf.toString("utf8");
        const rows = content.split(/\r?\n/);
        rows.forEach((row, i) => {
          if (matcher(row)) lines.push(`${rel}:${i + 1}:${row}`);
        });
      });
      return truncate(lines.join("\n") || "(no matches)", 20000);
    }

    return `Error: unknown search mode "${mode}". Use "text" or "glob".`;
  },
};

/**
 * Walk a directory tree, invoking `cb` for each file with its relative and
 * absolute path. Skips node_modules and hidden directories by default.
 */
function walk(root: string, cb: (rel: string, abs: string) => void): void {
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        cb(rel, abs);
      }
    }
  };
  visit(root);
}
