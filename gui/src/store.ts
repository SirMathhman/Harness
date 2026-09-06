// The reactive store: applies protocol events to the conversation and UI
// state (GUI spec §3.8, §3.9).

import { createSignal } from "solid-js";
import type { ConversationItem, ServerEvent, UIState } from "./types";

/** A rendered conversation row, with its nesting depth (0 = main). */
export interface Row {
  depth: number;
  item: ConversationItem;
  /** The subagent scope key the row belongs to, when it is part of a subagent. */
  scope?: string;
}

/** A block for rendering: either a single main-agent row or a subagent group. */
export type Block =
  | { kind: "row"; index: number; row: Row }
  | {
      kind: "subagent";
      scope: string;
      depth: number;
      done: boolean;
      items: { index: number; row: Row }[];
    };

/** The store: conversation rows, UI state, and event application. */
export function createStore() {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [state, setState] = createSignal<UIState | null>(null);
  const [lastError, setLastError] = createSignal<string | null>(null);

  // The index of the row currently receiving streamed text, per scope key.
  const streamingTarget = new Map<string, number>();
  // The set of row indices whose reasoning block is currently open (drives the
  // open/collapse of reasoning blocks). Reactive so the UI updates when it
  // changes. Per-scope: a token from one scope collapses only that scope's
  // reasoning block, so a main-agent token never collapses a subagent's block
  // and concurrent subagents each render open.
  const [activeReasoning, setActiveReasoning] = createSignal<Set<number>>(
    new Set(),
  );
  // The set of subagent scope keys that have completed (their `subagentEnd` was
  // received). Once set, the scope's block stays collapsed regardless of whether
  // it had other open rows. A scope not in this set is still running (its block
  // is open).
  const [doneSubagent, setDoneSubagent] = createSignal<Set<string>>(new Set());

  /** Add a row index to the open-reasoning set. */
  const addActive = (idx: number) =>
    setActiveReasoning((prev) => {
      const s = new Set(prev);
      s.add(idx);
      return s;
    });

  /** Remove a row index from the open-reasoning set (no-op if absent). */
  const removeActive = (idx: number | undefined) => {
    if (idx === undefined) return;
    setActiveReasoning((prev) => {
      if (!prev.has(idx)) return prev;
      const s = new Set(prev);
      s.delete(idx);
      return s;
    });
  };

  /** Clear all open-reasoning rows. */
  const clearActive = () => setActiveReasoning(new Set<number>());

  /** Reset all subagent open/done state. */
  const clearSubagents = () => {
    setDoneSubagent(new Set<string>());
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

  /** Append a row, returning its index. */
  const push = (depth: number, item: ConversationItem): number => {
    const next = [...rows(), { depth, item } as Row];
    setRows(next);
    return next.length - 1;
  };

  /** Append a subagent row tagged with its scope, returning its index. */
  const pushSubagent = (
    scopeKeyStr: string,
    depth: number,
    item: ConversationItem,
  ): number => {
    const next = [...rows(), { depth, item, scope: scopeKeyStr } as Row];
    setRows(next);
    return next.length - 1;
  };

  /**
   * Optimistically show the user's message the moment a task is sent (the
   * server does not echo it as a live event; it appears in the next snapshot).
   */
  const pushUserMessage = (text: string): void => {
    push(0, { kind: "userMessage", text });
  };

  /** Append text to the row at `index` (must be a text item). */
  const appendText = (index: number, text: string): void => {
    const next = [...rows()];
    const row = next[index];
    if (
      row &&
      (row.item.kind === "assistantMessage" ||
        row.item.kind === "reasoningBlock")
    ) {
      next[index] = {
        ...row,
        item: { ...row.item, text: row.item.text + text },
      };
      setRows(next);
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
    const isCurrent =
      idx !== undefined &&
      rows()[idx] !== undefined &&
      rows()[idx].item.kind === kind;
    let target = idx;
    if (!isCurrent || target === undefined) {
      target = subagent
        ? pushSubagent(subagent, depth, { kind, text: "" })
        : push(depth, { kind, text: "" });
      streamingTarget.set(key, target);
    }
    // Only reasoning blocks track an "active" (open) state; assistant text
    // does not. A token arriving after reasoning ends collapses it: `idx` is
    // the scope's previously-streamed row (the reasoning row in that case).
    if (kind === "reasoningBlock") addActive(target);
    else removeActive(idx);
    return target;
  };

  /** Apply one protocol event to the store. */
  const applyEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "snapshot": {
        setRows(event.history.map((item) => ({ depth: 0, item })));
        setState(event.state);
        streamingTarget.clear();
        clearActive();
        clearSubagents();
        // Replay the in-flight events to reconstruct the live turn.
        for (const e of event.inflight) applyEvent(e);
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
        if (isSubagentScope(event.scope)) {
          const saKey = scopeKey(event.scope);
          pushSubagent(saKey, depthOf(event.scope), {
            kind: "toolCall",
            name: event.name,
            args: event.args,
          });
        } else {
          push(depthOf(event.scope), {
            kind: "toolCall",
            name: event.name,
            args: event.args,
          });
        }
        return;
      }
      case "toolResult": {
        if (isSubagentScope(event.scope)) {
          const saKey = scopeKey(event.scope);
          pushSubagent(saKey, depthOf(event.scope), {
            kind: "toolResult",
            name: event.name,
            ok: event.ok,
            summary: event.summary,
          });
        } else {
          push(depthOf(event.scope), {
            kind: "toolResult",
            name: event.name,
            ok: event.ok,
            summary: event.summary,
          });
        }
        return;
      }
      case "compacting": {
        if (isSubagentScope(event.scope)) {
          pushSubagent(scopeKey(event.scope), depthOf(event.scope), {
            kind: "compactionNotice",
          });
        } else {
          push(depthOf(event.scope), { kind: "compactionNotice" });
        }
        return;
      }
      case "subagentEnd": {
        const key = scopeKey(event.scope);
        removeActive(streamingTarget.get(key));
        streamingTarget.delete(key);
        // Mark the scope as done so its block collapses.
        setDoneSubagent((prev) => new Set(prev).add(key));
        pushSubagent(key, event.depth, {
          kind: "systemNotice",
          text: `subagent ${event.ok ? "done" : "failed"} (${event.label})`,
        });
        return;
      }
      case "turnEnd": {
        // The answer is already visible: streamed as tokens in the plain-text
        // case, or in the `finish` tool call/result in the finished case.
        streamingTarget.clear();
        clearActive();
        clearSubagents();
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
        setRows([]);
        streamingTarget.clear();
        clearActive();
        clearSubagents();
        return;
      }
      case "commandResult": {
        if (!event.ok && event.error) setLastError(event.error);
        return;
      }
      case "pong":
      case "serverEvent":
        return;
    }
  };

  /** True when a subagent scope is still running (its block should stay open). */
  const isSubagentOpen = (key: string): boolean => !doneSubagent().has(key);

  /**
   * The blocks to render: main-agent rows (depth 0) pass through unchanged;
   * adjacent rows of the same subagent scope are grouped into one collapsible
   * block. Grouping is by maximal run of consecutive same-scope rows, which
   * mirrors how `subagentEnd` terminates a scope and lets an interleaved
   * subagent render as a single block once its scope ends.
   */
  const blocks = (): Block[] => {
    const out: Block[] = [];
    let group: Extract<Block, { kind: "subagent" }> | null = null;
    const rs = rows();
    const done = doneSubagent();
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (r.scope !== undefined) {
        // Merge into the current group when it's the same scope; otherwise
        // start a new group.
        if (group && group.scope === r.scope) {
          group.items.push({ index: i, row: r });
        } else {
          if (group) out.push(group);
          group = {
            kind: "subagent",
            scope: r.scope,
            depth: r.depth,
            done: done.has(r.scope),
            items: [{ index: i, row: r }],
          };
        }
      } else {
        if (group) {
          out.push(group);
          group = null;
        }
        out.push({ kind: "row", index: i, row: r });
      }
    }
    if (group) out.push(group);
    return out;
  };

  return {
    rows,
    state,
    lastError,
    activeReasoning,
    isActive: (idx: number): boolean => activeReasoning().has(idx),
    isSubagentOpen,
    blocks,
    applyEvent,
    pushUserMessage,
  };
}

/** A minimal empty UI state (before the first snapshot). */
function emptyState(): UIState {
  return {
    activeProfile: "",
    activeModel: null,
    cwd: "",
    context: { promptTokens: null, maxContext: 0 },
    profiles: [],
    models: [],
    skills: [],
    hooks: [],
    hooksEnabled: true,
    turnActive: false,
  };
}
