/**
 * The agent-server wire protocol (GUI spec §6.1).
 *
 * These types are the stable seam between the agent-server and the GUI
 * client. They are mirrored (by hand) in `gui/src/types.ts`; the protocol is
 * extended only additively — a client must ignore unknown event types.
 *
 * Pure boundary: this module imports nothing from the agent machinery so it
 * can be shared by transport, translation, and command handling without
 * creating cycles.
 */

/** The default port the agent-server binds to (GUI spec §3.1, §5). */
export const DEFAULT_GUI_PORT = 8787;

/** The WebSocket endpoint path (GUI spec §3.2). */
export const WS_PATH = "/ws";

/**
 * The protocol `Scope` (GUI spec §6.1): which agent produced an event.
 * `main` for the top-level agent; `subagent` carries an `id` that correlates
 * the subagent's events to its parent `spawn_subagent` call and a `depth`.
 */
export type Scope =
  | { kind: "main" }
  | { kind: "subagent"; id: string; depth: number };

/** A protocol event the server pushes to the client (GUI spec §6.1). */
export type ServerEvent =
  | {
      type: "snapshot";
      history: ConversationItem[];
      inflight: ServerEvent[];
      state: UIState;
    }
  | { type: "token"; scope: Scope; text: string }
  | { type: "reasoning"; scope: Scope; text: string }
  | {
      type: "toolCall";
      scope: Scope;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      scope: Scope;
      name: string;
      ok: boolean;
      summary: string;
    }
  | { type: "compacting"; scope: Scope }
  | {
      type: "subagentEnd";
      scope: Scope;
      ok: boolean;
      label: string;
      depth: number;
    }
  | {
      type: "turnEnd";
      answer: string;
      kind: "finished" | "cap" | "text" | "aborted";
      finished: boolean;
    }
  | { type: "error"; message: string; kind: "llm" | "other" }
  | { type: "state"; patch: Partial<UIState> }
  | {
      type: "commandResult";
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    }
  | { type: "cleared" }
  | { type: "pong" }
  | { type: "serverEvent"; name: string; payload: Record<string, unknown> };

/** A client command (GUI spec §6.1). */
export type ClientCommand =
  | { type: "task"; text: string }
  | { type: "abort" }
  | { type: "switchProfile"; name: string }
  | { type: "switchModel"; ref: string }
  | { type: "clear" }
  | { type: "newSession" }
  | { type: "hooks"; enabled: boolean }
  | { type: "ping" };

/** A rendered conversation item (GUI spec §2.1.3). */
export type ConversationItem =
  | { kind: "userMessage"; text: string }
  | { kind: "assistantMessage"; text: string }
  | { kind: "reasoningBlock"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> }
  | { kind: "toolResult"; name: string; ok: boolean; summary: string }
  | { kind: "compactionNotice" }
  | { kind: "systemNotice"; text: string };

/** The non-conversation UI state (GUI spec §2.1.4). */
export interface UIState {
  activeProfile: string;
  activeModel: string | null;
  context: { promptTokens: number | null; maxContext: number };
  profiles: { name: string; origin: string }[];
  models: { name: string; baseUrl: string; providerName: string | null }[];
  skills: { name: string; description: string }[];
  hooks: { events: string[]; source: string; tools?: string[] }[];
  hooksEnabled: boolean;
  turnActive: boolean;
}
