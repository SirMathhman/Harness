// The reactive store: applies protocol events to the conversation and UI
// state (GUI spec §3.8, §3.9).

import { createSignal } from "solid-js";
import type { ConversationItem, ServerEvent, UIState } from "./types";

/** A rendered conversation row, with its nesting depth (0 = main). */
export interface Row {
  depth: number;
  item: ConversationItem;
}

/** The store: conversation rows, UI state, and event application. */
export function createStore() {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [state, setState] = createSignal<UIState | null>(null);
  const [lastError, setLastError] = createSignal<string | null>(null);

  // The index of the row currently receiving streamed text, per scope key.
  const streamingTarget = new Map<string, number>();
  // The index of the row actively streaming reasoning (drives the open/
  // collapse of a reasoning block). Reactive so the UI updates when it changes.
  const [activeIdx, setActiveIdx] = createSignal<number | null>(null);

  const scopeKey = (scope: {
    kind: string;
    id?: string;
    depth?: number;
  }): string => (scope.kind === "main" ? "main" : `sub:${scope.id}`);

  const depthOf = (scope: { kind: string; depth?: number }): number =>
    scope.kind === "main" ? 0 : (scope.depth ?? 1);

  /** Append a row, returning its index. */
  const push = (depth: number, item: ConversationItem): number => {
    const next = [...rows(), { depth, item }];
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
   * Ensure the last row is a streaming text row of the given kind for the
   * given scope; create one if not. Returns the row index.
   */
  const ensureStreamingRow = (
    key: string,
    depth: number,
    kind: "assistantMessage" | "reasoningBlock",
  ): number => {
    const idx = streamingTarget.get(key);
    const last = rows()[rows().length - 1];
    const isCurrent =
      idx !== undefined &&
      last !== undefined &&
      rows()[idx] === last &&
      last.item.kind === kind;
    let target = idx;
    if (!isCurrent) {
      target = push(depth, { kind, text: "" });
      streamingTarget.set(key, target);
    }
    // Only reasoning blocks track an "active" (open) state; assistant text
    // does not. A token arriving after reasoning ends collapses it.
    setActiveIdx(kind === "reasoningBlock" ? target : null);
    return target;
  };

  /** Apply one protocol event to the store. */
  const applyEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "snapshot": {
        setRows(event.history.map((item) => ({ depth: 0, item })));
        setState(event.state);
        streamingTarget.clear();
        setActiveIdx(null);
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
        );
        appendText(idx, event.text);
        return;
      }
      case "toolCall": {
        streamingTarget.delete(scopeKey(event.scope));
        setActiveIdx(null);
        push(depthOf(event.scope), {
          kind: "toolCall",
          name: event.name,
          args: event.args,
        });
        return;
      }
      case "toolResult": {
        push(depthOf(event.scope), {
          kind: "toolResult",
          name: event.name,
          ok: event.ok,
          summary: event.summary,
        });
        return;
      }
      case "compacting": {
        push(depthOf(event.scope), { kind: "compactionNotice" });
        return;
      }
      case "subagentEnd": {
        streamingTarget.delete(scopeKey(event.scope));
        setActiveIdx(null);
        push(event.depth, {
          kind: "systemNotice",
          text: `subagent ${event.ok ? "done" : "failed"} (${event.label})`,
        });
        return;
      }
      case "turnEnd": {
        // The answer is already visible: streamed as tokens in the plain-text
        // case, or in the `finish` tool call/result in the finished case.
        streamingTarget.clear();
        setActiveIdx(null);
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
        setActiveIdx(null);
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

  return { rows, state, lastError, activeIdx, applyEvent, pushUserMessage };
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
