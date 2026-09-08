/**
 * kv-slot.ts — save/restore the llama.cpp slot KV cache around subagent runs.
 *
 * Mirrors what Vise's LlamaProvider does (src/providers/llamaProvider.ts):
 *   SubagentStart -> POST /slots/{id}?action=save     (write the spawner's
 *                    prompt cache to disk, freeing the slot for the subagent)
 *   SubagentStop  -> POST /slots/{id}?action=restore  (read it back, then
 *                    delete the file — llama.cpp has no delete endpoint)
 *
 * Fail-open, exactly like Vise (KV spec §3.8): every failure is a warning on
 * stderr and the hook exits 0, so a down llama.cpp server never blocks a
 * subagent. A restore is only attempted when the matching save succeeded
 * (tracked via a sidecar marker file, standing in for Vise's savedDepths set).
 *
 * The cache file is keyed by the subagent's agent_id — VS Code hooks expose no
 * depth, unlike Vise. The same agent_id appears in both the Start and Stop
 * events, which is what pairs a save with its restore.
 *
 * All output goes to stderr: with exit code 0 VS Code parses stdout as JSON,
 * so stdout must stay clean (empty) to avoid parse warnings.
 */

// --- machine-specific config (matches .vise/index.ts) -----------------------
import { unlink } from "node:fs/promises";
import { join } from "node:path";

const BASE_URL = "http://localhost:8080";
const SLOT_ID = 0;
const SLOT_SAVE_PATH = "C:\\Users\\mathm\\AppData\\Local\\llama-slots";
/**
 * The model whose slot to save/restore. Required by a llama.cpp *router* (one
 * server, many models), which needs it to know which model's slot to act on;
 * a plain single-model server ignores it. VS Code hook input carries no model
 * name, so it comes from here — keep it in sync with the loaded model.
 */
const MODEL = "orcarouter/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M";
// -----------------------------------------------------------------------------

/** Report a fail-open problem (Vise's `log`, stderr). */
function warn(message: string): void {
  console.error(`[kv-slot] ${message}`);
}

/** Report a successful save/restore (Vise's `note`, also stderr here). */
function note(message: string): void {
  console.error(`[kv-slot] ${message}`);
}

/** The message of a thrown value, whatever was thrown (Vise's `messageOf`). */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** Whether `path` exists (fail-closed: a probe error reads as "missing"). */
async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/** The cache file owned by the subagent run with this `agentId`. */
function kvCacheFileName(agentId: string): string {
  // Sanitize into a safe filename stem (keep alphanumerics + - _ .).
  const safeId = agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `kv-${safeId}.bin`;
}

interface HookInput {
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
}

/**
 * `POST /slots/{id}?action=save|restore` with `{"filename": ...}` — the same
 * call Vise's `slotAction` makes. Returns whether the server accepted it;
 * every failure mode is fail-open and only produces a warning.
 */
async function slotAction(
  action: "save" | "restore",
  filename: string,
): Promise<boolean> {
  const endpoint = `${BASE_URL}/slots/${SLOT_ID}?action=${action}`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        // The `model` field is required by a llama.cpp *router* (one server,
        // many models); a plain single-model server ignores it. Same shape as
        // Vise's `slotAction`.
        model: MODEL,
      }),
    });
    if (!response.ok) {
      // 501 is the server saying it was started without --slot-save-path.
      const hint =
        response.status === 501
          ? " (start llama-server with --slot-save-path DIR)"
          : "";
      const body = await response.text();
      warn(
        `KV ${action} of ${filename} failed: HTTP ${response.status}${hint} body=${body}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    warn(`KV ${action} of ${filename} failed: ${messageOf(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  // Read the whole stdin as one string, then parse as JSON.
  const raw = await Bun.stdin.text();
  if (raw.trim() === "") {
    warn("no input on stdin; nothing to do");
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    warn(`could not parse stdin as JSON: ${messageOf(err)}`);
    return;
  }

  const event = input.hook_event_name;
  const agentId = input.agent_id ?? "";
  if (agentId === "") {
    warn("no agent_id in input; nothing to do");
    return;
  }

  const filename = kvCacheFileName(agentId);
  const filePath = join(SLOT_SAVE_PATH, filename);
  // Sidecar marker: present only while a save has succeeded and not yet been
  // restored (stands in for Vise's savedDepths set).
  const markerPath = `${filePath}.saved`;

  if (event === "SubagentStart") {
    // KV spec §3.4: write the slot's prompt cache, freeing the slot for the
    // subagent. A failure is a warning: the subagent still runs and the
    // spawner re-prefills afterwards.
    if (await slotAction("save", filename)) {
      await Bun.write(markerPath, filename);
      note(`KV cache saved to ${filename}`);
    }
    return;
  }

  if (event === "SubagentStop") {
    // KV spec §3.5: read the cache back into the slot and delete it. Skipped
    // entirely when the matching save failed — there is nothing on disk.
    if (!(await exists(markerPath))) {
      warn(`no successful save for ${filename}; skipping restore`);
      return;
    }
    if (!(await slotAction("restore", filename))) {
      // Leave the marker so a later retry can still restore; the file stays
      // on disk.
      return;
    }
    try {
      await unlink(filePath);
    } catch (err) {
      // ENOENT is success: this llama.cpp build deletes the cache file itself
      // after a restore, so the file being already gone is the goal state.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // The file may linger until the next run overwrites it; the turn is
        // unaffected.
        warn(`could not delete ${filePath}: ${messageOf(err)}`);
      }
    }
    await unlink(markerPath).catch(() => {});
    note(`KV cache restored from ${filename}`);
    return;
  }

  warn(`unexpected event '${event}'; expected SubagentStart or SubagentStop`);
}

await main();
