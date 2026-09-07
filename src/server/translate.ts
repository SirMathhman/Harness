/**
 * Translation from session state to protocol events (GUI spec §3.8).
 *
 * These pure functions map the domain model (`Message`) and the session
 * handle into `ConversationItem`s and the reconnect `snapshot`. They are kept
 * free of instance state so the snapshot/history reconstruction logic can be
 * unit-tested on its own.
 */
import type { SessionHandle } from "../agent/session.js";
import type { Message } from "../types.js";
import type { ConversationItem, ServerEvent, UIState } from "./protocol.js";

/** Convert one message into zero or more conversation items. */
export function messageToItems(msg: Message): ConversationItem[] {
  switch (msg.role) {
    case "user":
      return [{ kind: "userMessage", text: msg.content ?? "" }];
    case "assistant": {
      const items: ConversationItem[] = [];
      if (msg.content) {
        items.push({ kind: "assistantMessage", text: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        items.push({ kind: "toolCall", name: tc.name, args: tc.arguments });
      }
      return items;
    }
    case "tool":
      return [
        {
          kind: "toolResult",
          name: msg.name ?? "tool",
          ok: !(msg.content ?? "").startsWith("Error:"),
          summary: firstLine(msg.content ?? ""),
        },
      ];
    case "system":
      // The system prompt is not part of the conversation (GUI spec §3.8:
      // history is user/assistant/tool messages only).
      return [];
  }
}

/** Reconstruct the conversation from session messages (GUI spec §3.8). */
export function buildHistory(handle: SessionHandle): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const msg of handle.session.messages) {
    items.push(...messageToItems(msg));
  }
  return items;
}

/** The non-conversation UI state, read off the session (GUI spec §2.1.4). */
export function buildUIState(
  handle: SessionHandle,
  turnActive: boolean,
): UIState {
  const session = handle.session;
  return {
    activeProfile: handle.profile,
    activeModel: session.config.model,
    cwd: process.cwd(),
    context: {
      promptTokens: session.lastPromptTokens,
      maxContext: session.contextWindow,
    },
    profiles: handle.profileEntries().map((p) => ({
      name: p.name,
      origin: p.origin,
    })),
    models: handle.modelEntries().map((m) => ({
      name: m.name,
      baseUrl: m.baseUrl,
      providerName: m.providerName,
    })),
    skills: handle.skills().map((s) => ({
      name: s.name,
      description: s.description,
    })),
    hooks: session.hooks.list().map((h) => ({
      events: h.hook.events,
      source: h.source,
      tools: h.tools,
    })),
    hooksEnabled: session.hooks.isEnabled(),
    turnActive,
  };
}

/**
 * The snapshot sent on (re)connect (GUI spec §3.8).
 *
 * Splits history at the turn boundary so the in-flight buffer does not
 * duplicate committed messages (GUI spec §3.8, §4.1).
 */
export function buildSnapshot(opts: {
  handle: SessionHandle;
  turnActive: boolean;
  turnStartMessageCount: number;
  inflightBuffer: ServerEvent[];
  buildState: () => UIState;
}): ServerEvent {
  const { handle, turnActive, turnStartMessageCount, inflightBuffer } = opts;
  const end = turnActive
    ? turnStartMessageCount + 1 // include this turn's user message
    : handle.session.messages.length;
  const items: ConversationItem[] = [];
  for (const msg of handle.session.messages.slice(0, end)) {
    items.push(...messageToItems(msg));
  }
  return {
    type: "snapshot",
    history: items,
    inflight: inflightBuffer,
    state: opts.buildState(),
  };
}

/** True for events that belong to the in-flight turn buffer. */
export function isTurnEvent(e: ServerEvent): boolean {
  return (
    e.type === "token" ||
    e.type === "reasoning" ||
    e.type === "toolCall" ||
    e.type === "toolResult" ||
    e.type === "compacting" ||
    e.type === "subagentEnd"
  );
}

/** The first non-empty line of a string (for tool-result summaries). */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? text).trim();
}
