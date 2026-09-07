// The reactive store: applies protocol events to the conversation and UI
// state (GUI spec §3.8, §3.9).
//
// Rendering is bounded to the viewport and to the rows that actually changed
// (v0.7.0 GUI performance work), so the store's job is to make *granular*
// updates: a streamed token must touch exactly one row's text and must not
// rebuild the rows array, the block sequence, or any row identity. That is why
// the conversation lives in a `solid-js/store` (path updates) rather than in a
// signal holding a copied array.

import { batch, createSignal } from "solid-js";
import { createStore as createSolidStore } from "solid-js/store";
import type {
  ConversationItem,
  ServerEvent,
  SessionInfo,
  UIState,
} from "./types";

/** A rendered conversation row, with its nesting depth (0 = main). */
export interface Row {
  /**
   * A stable local id, minted within the current snapshot generation. Rows are
   * append-only within a generation, so an id never moves and never changes
   * meaning; a new authoritative snapshot starts a new generation. These ids
   * are local to the client — the protocol carries no persistent row identity
   * and none is invented here.
   */
  id: string;
  /** The row's position in `rows()` (stable within a generation). */
  index: number;
  depth: number;
  item: ConversationItem;
  /** The subagent scope key the row belongs to, when it is part of a subagent. */
  scope?: string;
}

/** A block for rendering: either a single main-agent row or a subagent group. */
export type Block =
  | { kind: "row"; id: string; index: number; row: Row }
  | {
      kind: "subagent";
      /**
       * Identifies this *run* of the scope. A scope may appear in several
       * adjacent-run groups, so the id is derived from the run's first row id
       * (which already carries the generation), never from the scope alone.
       */
      id: string;
      scope: string;
      depth: number;
      done: boolean;
      items: { index: number; row: Row }[];
    };

/** The store: conversation rows, UI state, and event application. */
export function createStore() {
  // The conversation document. `rows` is the flat, append-only row list;
  // `blocks` is the structural sequence maintained *incrementally* alongside
  // it. Both hold the same row objects, so a path update to a row's text is
  // seen through either path without rebuilding anything.
  const [doc, setDoc] = createSolidStore<{ rows: Row[]; blocks: Block[] }>({
    rows: [],
    blocks: [],
  });
  // Reasoning-open facts, kept out of the structural lists so toggling one
  // does not invalidate the block sequence. Keyed by row index, so a read of
  // `ui.active[i]` subscribes to that row alone.
  const [ui, setUi] = createSolidStore<{ active: Record<number, boolean> }>({
    active: {},
  });
  const [state, setState] = createSignal<UIState | null>(null);
  const [lastError, setLastError] = createSignal<string | null>(null);
  // Saved sessions, refreshed by the server's `sessions` event (and after
  // save/rename/delete). Kept as a plain signal: the list is small and replaced
  // wholesale, never streamed.
  const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
  // Bumped by every authoritative reset (snapshot / cleared). The view layer
  // uses it to drop measurements, disclosure state and caches that belong to
  // the previous generation.
  const [generation, setGeneration] = createSignal(0);

  // `solid-js/store`'s path types cannot narrow a discriminated union part-way
  // along a path (`Block.items` and `ConversationItem.text` both live behind a
  // `kind` discriminant), so the three writes that need those paths go through
  // these loosened views of the setter. The runtime paths are exact, and each
  // call site guards the variant it writes into.
  const setRowText = setDoc as unknown as (
    rows: "rows",
    index: number,
    item: "item",
    text: "text",
    updater: (prev: string) => string,
  ) => void;
  const setGroupItem = setDoc as unknown as (
    blocks: "blocks",
    index: number,
    items: "items",
    at: number,
    value: { index: number; row: Row },
  ) => void;
  const setGroupDone = setDoc as unknown as (
    blocks: "blocks",
    index: number,
    done: "done",
    value: boolean,
  ) => void;

  // --- non-reactive bookkeeping (never read inside a tracking scope) -------

  let gen = 0;
  let rowSeq = 0;
  const nextRowId = (): string => `g${gen}:r${rowSeq++}`;

  // The index of the row currently receiving streamed text, per scope key.
  const streamingTarget = new Map<string, number>();
  // Row indices whose reasoning block is currently open. Mirrors `ui.active`
  // so clearing is targeted (one path write per genuinely-open row) instead of
  // allocating a fresh collection on every change.
  const activeIdx = new Set<number>();
  // Subagent scope keys whose `subagentEnd` has been received. Sticky for the
  // life of a generation: a completed group must not reopen when the main turn
  // ends.
  const doneScopes = new Set<string>();
  // Block indices per scope, so completing a scope can flip `done` on exactly
  // the blocks that belong to it.
  const scopeBlocks = new Map<string, number[]>();
  // A shadow of the block tail, so appending a row never has to read the store.
  let blockCount = 0;
  let tailScope: string | null = null;
  let tailItems = 0;

  /** Add a row index to the open-reasoning set. */
  const addActive = (idx: number): void => {
    if (activeIdx.has(idx)) return;
    activeIdx.add(idx);
    setUi("active", idx, true);
  };

  /** Remove a row index from the open-reasoning set (no-op if absent). */
  const removeActive = (idx: number | undefined): void => {
    if (idx === undefined || !activeIdx.has(idx)) return;
    activeIdx.delete(idx);
    setUi("active", idx, false);
  };

  /** Clear all open-reasoning rows. */
  const clearActive = (): void => {
    for (const idx of activeIdx) setUi("active", idx, false);
    activeIdx.clear();
  };

  const scopeKey = (scope: {
    kind: string;
    id?: string;
    depth?: number;
  }): string => (scope.kind === "main" ? "main" : `sub:${scope.id}`);

  const depthOf = (scope: { kind: string; depth?: number }): number =>
    scope.kind === "main" ? 0 : (scope.depth ?? 1);

  /** A subagent scope is any scope that is not the main agent. */
  const isSubagentScope = (scope: { kind: string }): boolean =>
    scope.kind !== "main";

  /**
   * Extend the block sequence with one freshly appended row.
   *
   * Grouping is by maximal run of consecutive same-scope rows, which mirrors
   * how `subagentEnd` terminates a scope and lets an interleaved subagent
   * render as a single block once its scope ends. A scope may therefore own
   * several runs, so each run carries its own id.
   */
  const linkBlock = (row: Row, index: number): void => {
    const scope = row.scope;
    if (scope === undefined) {
      setDoc("blocks", blockCount, { kind: "row", id: row.id, index, row });
      blockCount += 1;
      tailScope = null;
      tailItems = 0;
      return;
    }
    if (tailScope === scope) {
      setGroupItem("blocks", blockCount - 1, "items", tailItems, {
        index,
        row,
      });
      tailItems += 1;
      return;
    }
    const bi = blockCount;
    setDoc("blocks", bi, {
      kind: "subagent",
      id: `sub@${row.id}`,
      scope,
      depth: row.depth,
      done: doneScopes.has(scope),
      items: [{ index, row }],
    });
    blockCount = bi + 1;
    tailScope = scope;
    tailItems = 1;
    const list = scopeBlocks.get(scope);
    if (list) list.push(bi);
    else scopeBlocks.set(scope, [bi]);
  };

  /** Append a row, returning its index. */
  const push = (
    depth: number,
    item: ConversationItem,
    scope?: string,
  ): number => {
    const index = doc.rows.length;
    const row: Row =
      scope === undefined
        ? { id: nextRowId(), index, depth, item }
        : { id: nextRowId(), index, depth, item, scope };
    setDoc("rows", index, row);
    // Link the *stored* row so the block and the row list share one reactive
    // node: a later path write to the row's text is seen through both.
    linkBlock(doc.rows[index], index);
    return index;
  };

  /** Append a subagent row tagged with its scope, returning its index. */
  const pushSubagent = (
    scopeKeyStr: string,
    depth: number,
    item: ConversationItem,
  ): number => push(depth, item, scopeKeyStr);

  /**
   * Optimistically show the user's message the moment a task is sent (the
   * server does not echo it as a live event; it appears in the next snapshot).
   */
  const pushUserMessage = (text: string): void => {
    push(0, { kind: "userMessage", text });
  };

  /**
   * Append text to the row at `index` (must be a text item).
   *
   * This is the hot path: one path write into `rows[index].item.text`. It does
   * not copy the rows array, does not replace the row object and does not touch
   * the block sequence, so no other row re-renders.
   */
  const appendText = (index: number, text: string): void => {
    const row = doc.rows[index];
    if (
      row &&
      (row.item.kind === "assistantMessage" ||
        row.item.kind === "reasoningBlock")
    ) {
      setRowText("rows", index, "item", "text", (prev) => prev + text);
    }
  };

  /**
   * Ensure the scope has a streaming text row of the given kind; create one
   * if not. Returns the row index.
   *
   * Continuation is by scope identity (the `streamingTarget` map), not by
   * "is the last row": concurrent same-depth subagents interleave, so a
   * scope's row is not necessarily the last row when its next token arrives.
   */
  const ensureStreamingRow = (
    key: string,
    depth: number,
    kind: "assistantMessage" | "reasoningBlock",
    subagent?: string,
  ): number => {
    const idx = streamingTarget.get(key);
    const existing = idx !== undefined ? doc.rows[idx] : undefined;
    const isCurrent = existing !== undefined && existing.item.kind === kind;
    let target = idx;
    if (!isCurrent || target === undefined) {
      target = push(depth, { kind, text: "" }, subagent);
      streamingTarget.set(key, target);
    }
    // Only reasoning blocks track an "active" (open) state; assistant text
    // does not. A token arriving after reasoning ends collapses it: `idx` is
    // the scope's previously-streamed row (the reasoning row in that case).
    if (kind === "reasoningBlock") addActive(target);
    else removeActive(idx);
    return target;
  };

  /** Drop every per-generation fact and start a new generation. */
  const resetGeneration = (): void => {
    gen += 1;
    rowSeq = 0;
    streamingTarget.clear();
    clearActive();
    doneScopes.clear();
    scopeBlocks.clear();
    blockCount = 0;
    tailScope = null;
    tailItems = 0;
    setDoc({ rows: [], blocks: [] });
    setGeneration(gen);
  };

  /** Apply one protocol event to the store. Always synchronous. */
  const applyEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "snapshot": {
        // The snapshot is authoritative: rebuild once, inside one batch, then
        // replay the in-flight events to reconstruct the live turn.
        batch(() => {
          resetGeneration();
          for (const item of event.history) push(0, item);
          setState(event.state);
          for (const e of event.inflight) applyEvent(e);
        });
        return;
      }
      case "token": {
        const key = scopeKey(event.scope);
        const idx = ensureStreamingRow(
          key,
          depthOf(event.scope),
          "assistantMessage",
          isSubagentScope(event.scope) ? key : undefined,
        );
        appendText(idx, event.text);
        return;
      }
      case "reasoning": {
        const key = scopeKey(event.scope);
        const idx = ensureStreamingRow(
          key,
          depthOf(event.scope),
          "reasoningBlock",
          isSubagentScope(event.scope) ? key : undefined,
        );
        appendText(idx, event.text);
        return;
      }
      case "toolCall": {
        const key = scopeKey(event.scope);
        removeActive(streamingTarget.get(key));
        streamingTarget.delete(key);
        push(
          depthOf(event.scope),
          { kind: "toolCall", name: event.name, args: event.args },
          isSubagentScope(event.scope) ? key : undefined,
        );
        return;
      }
      case "toolResult": {
        const key = scopeKey(event.scope);
        push(
          depthOf(event.scope),
          {
            kind: "toolResult",
            name: event.name,
            ok: event.ok,
            summary: event.summary,
          },
          isSubagentScope(event.scope) ? key : undefined,
        );
        return;
      }
      case "compacting": {
        const key = scopeKey(event.scope);
        push(
          depthOf(event.scope),
          { kind: "compactionNotice" },
          isSubagentScope(event.scope) ? key : undefined,
        );
        return;
      }
      case "subagentEnd": {
        const key = scopeKey(event.scope);
        removeActive(streamingTarget.get(key));
        streamingTarget.delete(key);
        pushSubagent(key, event.depth, {
          kind: "systemNotice",
          text: `subagent ${event.ok ? "done" : "failed"} (${event.label})`,
        });
        // Mark the scope done so its block(s) collapse. Sticky for the
        // generation: the end of the main turn must not reopen it.
        doneScopes.add(key);
        for (const bi of scopeBlocks.get(key) ?? []) {
          setGroupDone("blocks", bi, "done", true);
        }
        return;
      }
      case "turnEnd": {
        // The answer is already visible: streamed as tokens in the plain-text
        // case, or in the `finish` tool call/result in the finished case.
        // `doneScopes` is deliberately *not* cleared — a subagent that
        // completed stays collapsed when the turn it ran in finishes.
        streamingTarget.clear();
        clearActive();
        return;
      }
      case "error": {
        setLastError(event.message);
        push(0, { kind: "systemNotice", text: `error: ${event.message}` });
        return;
      }
      case "state": {
        setState((prev) => ({ ...(prev ?? emptyState()), ...event.patch }));
        return;
      }
      case "cleared": {
        resetGeneration();
        return;
      }
      case "commandResult": {
        if (!event.ok && event.error) setLastError(event.error);
        return;
      }
      case "sessions": {
        setSessions(event.sessions);
        return;
      }
      case "sessionSaved":
      case "sessionDeleted":
      case "sessionLoaded":
        // The list refresh and the conversation reset are driven elsewhere:
        // save/delete trigger a `sessions` request from the view, and load is
        // followed by an authoritative snapshot that rebuilds the rows.
        return;
      case "pong":
      case "serverEvent":
        return;
    }
  };

  /** True when a subagent scope is still running (its block should stay open). */
  const isSubagentOpen = (key: string): boolean => !doneScopes.has(key);

  return {
    rows: (): readonly Row[] => doc.rows,
    /**
     * The blocks to render: main-agent rows (depth 0) pass through unchanged;
     * adjacent rows of the same subagent scope are grouped into one collapsible
     * block. Maintained incrementally — reading it never scans the history, and
     * a text-only change never invalidates it.
     */
    blocks: (): readonly Block[] => doc.blocks,
    state,
    lastError,
    sessions,
    generation,
    activeReasoning: (): Set<number> => {
      const out = new Set<number>();
      for (const key of Object.keys(ui.active)) {
        if (ui.active[Number(key)]) out.add(Number(key));
      }
      return out;
    },
    isActive: (idx: number): boolean => ui.active[idx] === true,
    isSubagentOpen,
    applyEvent,
    pushUserMessage,
  };
}

/** The store's public shape (the view layer depends on this, not on Solid). */
export type Store = ReturnType<typeof createStore>;

/** A minimal empty UI state (before the first snapshot). */
function emptyState(): UIState {
  return {
    activeProfile: "",
    activeModel: null,
    cwd: "",
    context: { promptTokens: null, maxContext: null },
    profiles: [],
    models: [],
    skills: [],
    hooks: [],
    hooksEnabled: true,
    turnActive: false,
  };
}
